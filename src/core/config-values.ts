import { readFile } from "fs/promises";
import { join, resolve } from "path";
import { glob } from "./glob.js";
import { isSensitive } from "./file-discovery.js";
import { urlValue } from "./url-values.js";
import { byOrdinal } from "./ordinal.js";
import { readDockerfile } from "./dockerfiles.js";
import { CONFIG_SOURCES, PROXY_SOURCES } from "../extractors/registry.js";
import type { ProxyRule, SubProject } from "../types/analysis.js";
import type { ConfigEntry, ConfigSourceSpec, ProxySourceSpec } from "../types/language-plugin.js";

/**
 * The addresses each sub-project's configuration files state: where it is
 * told other services are (`Services:Inventory = http://localhost:5102`) and
 * where it listens itself (launchSettings `applicationUrl`).
 *
 * Every format belongs to a plugin (`serviceConfig.sources`); core walks the
 * roots, reads the files and keeps ONLY values that are addresses, with any
 * credentials stripped (`urlValue`) — a connection string or an API key in
 * the same file is dropped before it is stored anywhere. Files discovery
 * treats as secrets (`.env`, `*.pem`, `secrets.json`) are never opened.
 *
 * In memory only: what reaches the summary is the resolved origin on each
 * call, and the listen URLs as service addresses.
 */
export interface ProjectConfigValue extends ConfigEntry {
  /** Project-relative posix path of the file stating it. */
  file: string;
}

const IGNORE = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/bin/**", "**/obj/**", "**/vendor/**"];

/** Read a file as UTF-8, or null when it cannot be read. */
async function readIf(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, "utf-8");
  } catch {
    return null;
  }
}

/**
 * The config files a spec names under one root: its literal file names, or a
 * bounded, sorted glob when the spec declares one.
 */
async function filesOf(absRoot: string, spec: ConfigSourceSpec | ProxySourceSpec): Promise<string[]> {
  if (!spec.glob) return [...spec.files];
  const found = await glob([...spec.files], { cwd: absRoot, ignore: IGNORE, deep: spec.glob.deep, absolute: false });
  return found.sort(byOrdinal).slice(0, spec.glob.limit);
}

/**
 * Every file of `specs` at each sub-project root, parsed: what `read` makes
 * of one file's text, per sub-project id. Sensitive files are never opened.
 */
async function readAtRoots<S extends ConfigSourceSpec | ProxySourceSpec, T>(
  projectRoot: string,
  subProjects: readonly SubProject[],
  specs: readonly S[],
  read: (spec: S, text: string, path: string, file: string) => T[],
): Promise<Map<string, T[]>> {
  const out = new Map<string, T[]>();
  if (specs.length === 0) return out;
  const root = resolve(projectRoot);
  for (const sp of subProjects) {
    const rel = sp.root.replace(/\\/g, "/").replace(/\/+$/, "");
    const absRoot = rel ? join(root, rel) : root;
    const values: T[] = [];
    for (const spec of specs) {
      for (const path of await filesOf(absRoot, spec)) {
        const file = rel ? `${rel}/${path}` : path;
        if (isSensitive(file)) continue;
        const text = await readIf(join(absRoot, path));
        if (!text || text.length > 1_000_000) continue;
        values.push(...read(spec, text, path, file));
      }
    }
    if (values.length) out.set(sp.id, values);
  }
  return out;
}

/** Address-valued configuration per sub-project id. */
export function readProjectConfig(
  projectRoot: string,
  subProjects: readonly SubProject[],
  sources: readonly ConfigSourceSpec[] = CONFIG_SOURCES,
): Promise<Map<string, ProjectConfigValue[]>> {
  return readAtRoots(projectRoot, subProjects, sources, (spec, text, path, file) =>
    spec.parse(text, path).flatMap((entry) => {
      const value = urlValue(entry.value);
      return value ? [{ ...entry, value, file }] : [];
    }),
  );
}

/**
 * Forwarding rules the configuration files at each sub-project root declare
 * (Angular proxy.conf.json, YARP, Ocelot) — targets kept only as addresses.
 */
export function readProjectProxies(
  projectRoot: string,
  subProjects: readonly SubProject[],
  sources: readonly ProxySourceSpec[] = PROXY_SOURCES,
): Promise<Map<string, ProxyRule[]>> {
  return readAtRoots(projectRoot, subProjects, sources, (spec, text, path, file) =>
    spec.parse(text, path).flatMap((rule) => {
      const target = urlValue(withImageEnv(rule.target, projectRoot, file));
      return target ? [{ ...rule, target, file }] : [];
    }),
  );
}

/**
 * A target written as a template the container fills at start
 * (`http://${API_SERVICE_NAME}` in an nginx `templates/*.template`), with
 * each `${VAR}` the image's Dockerfile beside the file — or in a directory
 * above it — sets with `ENV`. Left as written when one is not set there.
 */
function withImageEnv(target: string, projectRoot: string, file: string): string {
  if (!target.includes("${")) return target;
  const parts = file.split("/").slice(0, -1);
  for (let n = parts.length; n >= 0; n--) {
    const env = readDockerfile(resolve(projectRoot), [...parts.slice(0, n), "Dockerfile"].join("/"))?.env;
    if (!env) continue;
    return target.replace(/\$\{([A-Za-z_]\w*)\}/g, (hole, name: string) => env[name] ?? hole);
  }
  return target;
}
