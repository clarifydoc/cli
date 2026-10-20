import { glob } from "./glob.js";
import { urlValue } from "./url-values.js";
import { byOrdinal } from "./ordinal.js";
import { readFile } from "fs/promises";
import { join, posix, resolve } from "path";
import type {
  DeployedService,
  DeployedServiceKind,
  DeploymentEdge,
  DeploymentExternal,
  DeploymentModel,
  SubProject,
} from "../types/analysis.js";
import { collectK8sManifests } from "./deployment-k8s.js";
import { entryFileOf, readDockerfile, repoFiles, type DockerfileFacts } from "./dockerfiles.js";
import { collectTerraform } from "./deployment-terraform.js";

/**
 * Deployment-topology extraction from docker-compose / compose manifests.
 *
 * Compose files are the one place a repo states its RUNTIME shape — which
 * units actually deploy (vs. which projects merely exist), what infrastructure
 * they attach to, and (through injected env) who talks to whom. That makes
 * them the authority for the Architecture tab's Context (C1) and Deployment
 * (C2) levels, where the code-derived project grouping can only approximate.
 *
 * Everything here is evidence-based and name-agnostic (no hardcoded product
 * or service names): edges come from generic env-var patterns —
 *   - API-key handshake: service A authenticates with `...Authenticator...ApiKey:
 *     ${V}` and service B carries any env value referencing ${V} → B calls A.
 *     Derived PER FILE: key vars are stack-scoped, and repos often carry
 *     several deployment stacks whose var names drifted apart.
 *   - Service-URL reference: an env value contains `://<service-name>` or a
 *     `*_URL`-style var name prefixed with another service's name → caller edge.
 *   - Connection strings: `Database=`/`initial catalog=` literals (or the
 *     connection var's own name) identify a logical database; the plain
 *     `ConnectionString` key marks the service's OWN db, decorated keys
 *     (`PlanConnectionString`) mark cross-database access.
 *   - Bus/cache attachment: EventBus/AMQP/Kafka/Redis env vars.
 *   - Externals: literal http(s) URLs and `*_URL`/`*_ISSUER` placeholders that
 *     resolve to no compose service.
 *
 * A repo can declare the same service in several stacks (legacy + current,
 * base + local variant). Services dedupe case-insensitively by name: the
 * first declaration that carries an image/entrypoint wins as the base record
 * and later declarations only fill gaps, so metadata-only manifests
 * (rancher-compose.yml) can't hollow out the model.
 */

// ─── Minimal YAML subset parser ─────────────────────────────────────────────
// Compose files in the wild are a narrow YAML subset: nested maps by
// indentation, scalar values, `- item` sequences and inline `[a, b]` arrays.
// Parsing that subset directly avoids a YAML dependency; anything the parser
// doesn't understand degrades to a missing key, never a crash. Anchors,
// aliases and multi-line scalars are out of scope by design.

/**
 * A value in the YAML subset the compose parser understands: a scalar string,
 * a sequence, or a nested map. Numbers and booleans stay strings.
 */
export type YamlValue = string | YamlValue[] | YamlMap;
/** A YAML mapping in the parsed subset. */
export interface YamlMap {
  [key: string]: YamlValue;
}

interface YamlLine {
  indent: number;
  text: string;
}

/** Cut a `#` comment off a YAML line, ignoring `#` inside quotes and inside a word. */
function stripComment(raw: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/** Drop one pair of matching surrounding quotes, if present. */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split `key: value` at the first `: ` (or trailing `:`). Returns null when the line isn't a mapping entry. */
function splitKeyValue(text: string): { key: string; value: string } | null {
  // Quoted key: "some: key": value
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    const close = text.indexOf(q, 1);
    if (close > 0 && text[close + 1] === ":") {
      return { key: text.slice(1, close), value: text.slice(close + 2).trim() };
    }
  }
  const sep = text.indexOf(": ");
  if (sep > 0) return { key: text.slice(0, sep).trim(), value: text.slice(sep + 2).trim() };
  if (text.endsWith(":")) return { key: text.slice(0, -1).trim(), value: "" };
  return null;
}

/** Parse an inline `[a, b]` sequence; null when the value is not one. */
function parseInlineArray(v: string): YamlValue[] | null {
  const t = v.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((p) => unquote(p));
}

/**
 * Parse the compose-file YAML subset described above.
 *
 * Comments are stripped (quote-aware), blank lines dropped, and nesting read
 * from indentation. Constructs outside the subset degrade to a missing key
 * rather than an error.
 *
 * @param text - YAML source
 * @returns The top-level mapping, or an empty map when the document is not one
 */
export function parseSimpleYaml(text: string): YamlMap {
  const lines: YamlLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const cut = stripComment(raw).replace(/\s+$/, "");
    if (!cut.trim()) continue;
    const indent = cut.length - cut.trimStart().length;
    lines.push({ indent, text: cut.trim() });
  }

  let pos = 0;

  /** A block scalar's text (`run: |`, `command: >`): the lines indented deeper than its key. */
  function blockScalar(style: string, keyIndent: number): string {
    const parts: string[] = [];
    while (pos < lines.length && lines[pos].indent > keyIndent) parts.push(lines[pos++].text);
    return parts.join(style.startsWith(">") ? " " : "\n");
  }
  const BLOCK_SCALAR = /^[|>][+-]?\d*$/;
  /** A sequence may sit at its key's own indentation (`steps:` then `- uses: …` beneath, not indented). */
  const sameIndentSequence = (keyIndent: number): boolean =>
    pos < lines.length && lines[pos].indent === keyIndent && (lines[pos].text === "-" || lines[pos].text.startsWith("- "));

  function parseBlock(minIndent: number): YamlValue {
    if (pos >= lines.length) return "";
    const first = lines[pos];
    if (first.indent < minIndent) return "";
    const blockIndent = first.indent;

    if (first.text === "-" || first.text.startsWith("- ")) {
      const arr: YamlValue[] = [];
      while (pos < lines.length && lines[pos].indent === blockIndent && (lines[pos].text === "-" || lines[pos].text.startsWith("- "))) {
        const item = lines[pos].text === "-" ? "" : lines[pos].text.slice(2).trim();
        pos++;
        const kv = item ? splitKeyValue(item) : null;
        if (kv) {
          // `- key: value` item — a map whose first entry is inline; deeper
          // lines under the dash extend it.
          const map: YamlMap = {};
          map[kv.key] = BLOCK_SCALAR.test(kv.value)
            ? blockScalar(kv.value, blockIndent)
            // Nested under the item's first key: deeper than the key's column, or a sequence at it.
            : kv.value === "" && pos < lines.length && (lines[pos].indent > blockIndent + 2 || sameIndentSequence(blockIndent + 2))
              ? parseBlock(lines[pos].indent)
              : (parseInlineArray(kv.value) ?? unquote(kv.value));
          while (pos < lines.length && lines[pos].indent > blockIndent) {
            const sub = splitKeyValue(lines[pos].text);
            if (!sub) { pos++; continue; }
            const subIndent = lines[pos].indent;
            pos++;
            map[sub.key] = BLOCK_SCALAR.test(sub.value)
              ? blockScalar(sub.value, subIndent)
              : sub.value === "" && pos < lines.length && (lines[pos].indent > subIndent || sameIndentSequence(subIndent))
                ? parseBlock(lines[pos].indent)
                : (parseInlineArray(sub.value) ?? unquote(sub.value));
          }
          arr.push(map);
        } else {
          arr.push(unquote(item));
        }
      }
      return arr;
    }

    const map: YamlMap = {};
    while (pos < lines.length && lines[pos].indent === blockIndent) {
      const kv = splitKeyValue(lines[pos].text);
      if (!kv) { pos++; continue; }
      pos++;
      if (BLOCK_SCALAR.test(kv.value)) {
        map[kv.key] = blockScalar(kv.value, blockIndent);
      } else if (kv.value !== "") {
        map[kv.key] = parseInlineArray(kv.value) ?? unquote(kv.value);
      } else if (pos < lines.length && (lines[pos].indent > blockIndent || sameIndentSequence(blockIndent))) {
        map[kv.key] = parseBlock(lines[pos].indent);
      } else {
        map[kv.key] = "";
      }
    }
    return map;
  }

  const out = parseBlock(0);
  return typeof out === "object" && !Array.isArray(out) ? out : {};
}

// ─── Compose discovery & raw services ───────────────────────────────────────

/**
 * Directories never searched for compose files: dependency and build output
 * trees, which routinely vendor example stacks.
 */
export const IGNORE = [
  "**/node_modules/**", "**/dist/**", "**/.git/**", "**/bin/**", "**/obj/**",
  "**/vendor/**", "**/build/**", "**/out/**", "**/target/**",
];

/**
 * Path tokens that mark a compose file as non-runtime (build/test/CI stacks,
 * vendored examples). Tested against every path segment, token-delimited, so
 * `deployment/PR/docker-compose.yml` and `league-tests-compose.yml` are both
 * excluded while `production/` or `services/` pass.
 */
export const NON_RUNTIME_RE = /(^|[^a-z0-9])(build|test|tests|ci|pr|example|examples|sample|samples|demo)([^a-z0-9]|$)/i;
/** Tokens that mark an environment variant — parsed, but after the base files. */
const VARIANT_RE = /(^|[^a-z0-9])(local|macos|osx|windows|ports|override|dev)([^a-z0-9]|$)/i;

/**
 * One service as declared in one manifest, before deployment modelling.
 *
 * Shared by the compose parser and the Kubernetes translator so both feed the
 * same merge: `file` is the manifest it came from, `env` the literal
 * environment it sets, `dependsOn` the services it names.
 */
export interface RawService {
  name: string;
  file: string;
  image?: string;
  entrypoint?: string;
  env: Record<string, string>;
  dependsOn: string[];
  /** Host ports published onto the service (`"5101:8080"` → 5101). */
  ports?: number[];
  /** Other names the service answers to: `hostname`, `container_name`, network aliases. */
  aliases?: string[];
  /** Compose `build:` — the context directory and Dockerfile, repo-relative. */
  build?: { context: string; dockerfile?: string };
  /** What the service's Dockerfile says (read after merging). */
  docker?: DockerfileFacts;
  /** Kind and family stated by the source itself (a Terraform `aws_sqs_queue`), over the image-based guess. */
  kind?: DeployedServiceKind;
  family?: string;
  /** The entry file the source states (a Lambda's handler module), over the command-based one. */
  entryFile?: string;
}

/**
 * Host ports from compose `ports:` — short form `"5101:8080"`,
 * `"127.0.0.1:5101:8080/tcp"` (a lone `"8080"` publishes none), or the long
 * form's `published:`.
 */
function hostPorts(v: YamlValue | undefined): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      const parts = unquote(item).split("/")[0]!.split(":");
      if (parts.length < 2) continue;
      const port = Number(parts[parts.length - 2]);
      if (Number.isInteger(port) && port > 0) out.push(port);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const published = (item as YamlMap).published;
      const port = typeof published === "string" ? Number(unquote(published)) : NaN;
      if (Number.isInteger(port) && port > 0) out.push(port);
    }
  }
  return out;
}

/** `hostname`, `container_name` and every `networks.<n>.aliases` entry. */
function serviceAliases(b: YamlMap): string[] {
  const out: string[] = [];
  for (const key of ["hostname", "container_name"]) {
    const v = b[key];
    if (typeof v === "string" && v && !v.includes("${")) out.push(unquote(v));
  }
  const nets = b.networks;
  if (nets && typeof nets === "object" && !Array.isArray(nets)) {
    for (const net of Object.values(nets as YamlMap)) {
      if (net && typeof net === "object" && !Array.isArray(net)) out.push(...asStringArray((net as YamlMap).aliases));
    }
  }
  return out;
}

/** A scalar, a sequence or a map's keys as a string list; undefined → empty. */
function asStringArray(v: YamlValue | undefined): string[] {
  if (v === undefined) return [];
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return Object.keys(v);
}

/** Normalize both compose environment forms (map, or list of `K=V`) to a map. */
function envMap(v: YamlValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (v === undefined) return out;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      if (eq > 0) out[item.slice(0, eq).trim()] = unquote(item.slice(eq + 1));
    }
    return out;
  }
  if (typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string") out[k] = val;
    }
  }
  return out;
}

/** Compose `build: ./orders` or `build: { context: ., dockerfile: orders/Dockerfile }`, relative to the compose file. */
function buildOf(v: YamlValue | undefined, composeFile: string): RawService["build"] {
  const dir = posix.dirname(composeFile);
  const rel = (p: string) => {
    const n = posix.normalize(posix.join(dir === "." ? "" : dir, unquote(p)));
    return n === "." ? "" : n.replace(/\/$/, "");
  };
  if (typeof v === "string" && v && !v.includes("${") && !/^[a-z]+:\/\//.test(v)) return { context: rel(v) };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const ctx = typeof v.context === "string" && !v.context.includes("${") ? v.context : ".";
    if (/^[a-z]+:\/\//.test(ctx)) return undefined;
    const df = typeof v.dockerfile === "string" && !v.dockerfile.includes("${") ? unquote(v.dockerfile) : undefined;
    return { context: rel(ctx), ...(df ? { dockerfile: df } : {}) };
  }
  return undefined;
}

/**
 * Every entry under `services:` of one compose document as a `RawService`
 * (image, joined entrypoint + command, env, depends_on, ports, aliases).
 */
function collectRawServices(doc: YamlMap, file: string): RawService[] {
  const services = doc.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return [];
  const out: RawService[] = [];
  for (const [name, body] of Object.entries(services)) {
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const b = body as YamlMap;
    const entry = [...asStringArray(b.entrypoint), ...asStringArray(b.command)].join(" ").trim();
    const build = buildOf(b.build, file);
    out.push({
      name,
      file,
      image: typeof b.image === "string" && b.image ? b.image : undefined,
      entrypoint: entry || undefined,
      env: envMap(b.environment),
      dependsOn: asStringArray(b.depends_on),
      ports: hostPorts(b.ports),
      aliases: serviceAliases(b),
      ...(build ? { build } : {}),
    });
  }
  return out;
}

// ─── Service classification ─────────────────────────────────────────────────

const INFRA_FAMILIES: Array<{ re: RegExp; kind: DeployedServiceKind; family: string }> = [
  { re: /postgres|pgsql|pgvector|timescale|cockroach/i, kind: "datastore", family: "postgres" },
  // Vector databases: an embedding store is the datastore of a RAG service.
  { re: /qdrant|weaviate|milvus|chroma(?:db)?(?![a-z])|vespa|marqo/i, kind: "datastore", family: "vector" },
  { re: /mysql|mariadb/i, kind: "datastore", family: "mysql" },
  { re: /mssql|sqlserver|sql-server/i, kind: "datastore", family: "sqlserver" },
  { re: /mongo/i, kind: "datastore", family: "mongodb" },
  { re: /firebird/i, kind: "datastore", family: "firebird" },
  { re: /oracle/i, kind: "datastore", family: "oracle" },
  { re: /elasticsearch|opensearch|solr/i, kind: "datastore", family: "search" },
  { re: /rabbitmq/i, kind: "queue", family: "rabbitmq" },
  { re: /kafka|redpanda/i, kind: "queue", family: "kafka" },
  { re: /activemq|artemis|nats(?![a-z])|mosquitto|emqx/i, kind: "queue", family: "mq" },
  { re: /redis|keydb|valkey|memcached/i, kind: "cache", family: "redis" },
  { re: /traefik|haproxy|envoy|nginx|ingress/i, kind: "proxy", family: "proxy" },
  { re: /graylog|grafana|prometheus|jaeger|zipkin|kibana|loki/i, kind: "observability", family: "observability" },
];

/** Last image path segment without registry/tag: `reg.io/org/rabbitmq:3.8` → `rabbitmq`. */
function imageTail(image: string | undefined): string | undefined {
  if (!image) return undefined;
  const noDigest = image.split("@")[0]!;
  const last = noDigest.slice(noDigest.lastIndexOf("/") + 1);
  const colon = last.indexOf(":");
  const seg = colon < 0 ? last : last.slice(0, colon);
  return seg || undefined;
}

/**
 * Infra family of a service by its image name — or, when it has no image, by
 * its service name — against `INFRA_FAMILIES`; everything else is an app.
 */
function classify(svc: RawService): { kind: DeployedServiceKind; family?: string } {
  if (svc.kind) return { kind: svc.kind, ...(svc.family ? { family: svc.family } : {}) };
  // The image identifies infra; the service name alone is a weaker fallback
  // (an app service named `redis-admin-ui` must not become infra, so name
  // matching only applies when there is no image to judge by).
  const probe = imageTail(svc.image) ?? svc.name;
  for (const f of INFRA_FAMILIES) {
    if (f.re.test(probe)) return { kind: f.kind, family: f.family };
  }
  return { kind: "app" };
}

// ─── Sub-project matching ───────────────────────────────────────────────────

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Artifact base from an entrypoint: `dotnet Plan.API.dll` → `Plan.API`; `app-1.2.jar` → `app`. */
function entryArtifact(entrypoint: string | undefined): string | undefined {
  if (!entrypoint) return undefined;
  for (const tok of entrypoint.split(/\s+/)) {
    const seg = tok.slice(Math.max(tok.lastIndexOf("/"), tok.lastIndexOf("\\")) + 1);
    const dot = seg.lastIndexOf(".");
    if (dot <= 0 || !/^(?:dll|jar|war)$/i.test(seg.slice(dot + 1))) continue;
    const base = seg.slice(0, dot);
    // `app-1.2` → `app`: a version suffix is a dash, a digit, then digits and dots to the end.
    const dash = base.lastIndexOf("-");
    return dash >= 0 && /^\d[\d.]*$/.test(base.slice(dash + 1)) ? base.slice(0, dash) : base;
  }
  return undefined;
}

/** Sub-projects by the names a deployed unit may carry: project name, and project-file marker basenames. */
interface ProjectIndex {
  byExact: Map<string, SubProject[]>;
  byNorm: Map<string, SubProject[]>;
}

/**
 * Index sub-projects by exact and normalized name (and by the names of their
 * project files) so a compose service can be matched to the code it runs.
 */
function indexProjects(subProjects: readonly SubProject[]): ProjectIndex {
  const byExact = new Map<string, SubProject[]>();
  const byNorm = new Map<string, SubProject[]>();
  for (const sp of subProjects) {
    if (sp.id !== "root") {
      const lower = sp.name.toLowerCase();
      (byExact.get(lower) ?? byExact.set(lower, []).get(lower)!).push(sp);
      const norm = normName(sp.name);
      if (norm) (byNorm.get(norm) ?? byNorm.set(norm, []).get(norm)!).push(sp);
    }
    // Named project-file markers carry a matchable identity even when the
    // project itself doesn't (the root catch-all is named "(root)" but its
    // marker may be SampleMq.csproj → entrypoint SampleMq.dll).
    for (const marker of sp.markers ?? []) {
      const base = marker.split("/").pop() ?? "";
      // .sln deliberately excluded: a solution names the repo, not a deployable
      // project — matching it would glue every same-image service to root.
      const m = base.match(/^(.+)\.(csproj|fsproj|vbproj|gemspec|cabal)$/i);
      if (!m) continue;
      const mn = normName(m[1]);
      if (mn && !(byNorm.get(mn) ?? []).includes(sp)) (byNorm.get(mn) ?? byNorm.set(mn, []).get(mn)!).push(sp);
    }
  }
  return { byExact, byNorm };
}

/**
 * The sub-project a deployed service runs: its entrypoint artifact
 * (`Plan.API.dll`), then its image's last segment, then its own name, each
 * matched against project names and project-file markers. `pick` decides
 * between several candidates at one tier.
 */
function matchProject(
  svc: Pick<RawService, "name" | "image" | "entrypoint">,
  { byExact, byNorm }: ProjectIndex,
  pick: (cands: SubProject[] | undefined) => string | undefined,
): string | undefined {
  const artifact = entryArtifact(svc.entrypoint);
  if (artifact) {
    const hit = pick(byExact.get(artifact.toLowerCase())) ?? pick(byNorm.get(normName(artifact)));
    if (hit) return hit;
  }
  const tail = imageTail(svc.image);
  if (tail) {
    const hit = pick(byNorm.get(normName(tail)));
    if (hit) return hit;
  }
  return pick(byNorm.get(normName(svc.name)));
}

/**
 * The ONE sub-project a deployed service runs, among `subProjects` — for a
 * caller holding services and projects from separate analyses (linking
 * repositories: an infra repo's compose service, another repo's project). Unlike the in-analysis match, a tie between candidates matches
 * nothing: across repositories there is no file count to break it with.
 */
export function matchServiceToProject(
  svc: { name: string; image?: string; entrypoint?: string },
  subProjects: readonly SubProject[],
): string | undefined {
  return matchProject(svc, indexProjects(subProjects), (cands) => {
    const ids = [...new Set((cands ?? []).map((c) => c.id))];
    return ids.length === 1 ? ids[0] : undefined;
  });
}

/**
 * The sub-project a build context builds: the deepest project whose root
 * holds the context, else the one project inside the context.
 */
export function projectOfContext(context: string, subProjects: readonly SubProject[]): string | undefined {
  const inside = (dir: string, root: string) => root === "" || dir === root || dir.startsWith(root + "/");
  const holding = subProjects.filter((p) => inside(context, p.root)).sort((a, b) => b.root.length - a.root.length);
  if (holding[0] && holding[0].root !== "") return holding[0].id;
  const within = subProjects.filter((p) => p.root !== "" && inside(p.root, context));
  if (within.length === 1) return within[0]!.id;
  return holding[0]?.id;
}

/** Dockerfiles outside dependency, build and non-runtime (test, example, CI) directories. */
async function standaloneDockerfiles(absRoot: string): Promise<string[]> {
  const found = await glob(["**/Dockerfile", "**/Dockerfile.*", "**/*.Dockerfile", "**/*.dockerfile"], {
    cwd: absRoot,
    ignore: IGNORE,
    absolute: false,
    caseSensitiveMatch: false,
    deep: 5,
  });
  return found
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.split("/").every((seg) => !NON_RUNTIME_RE.test(seg)) && !/(?:^|[.-])(?:dev|debug|local|test|ci)(?:[.-]|$)/i.test(f.split("/").pop()!))
    .sort(byOrdinal)
    .slice(0, 20);
}

// ─── Env-derived edges ──────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\$\{([A-Za-z0-9_.-]+)\}/;
const PLACEHOLDER_ALL_RE = /\$\{([A-Za-z0-9_.-]+)\}/g;
/** Env key that marks the service as AUTHENTICATING inbound calls with this key. */
const AUTH_PROVIDER_KEY_RE = /authenticat[a-z]*(__|_|\.)?api.?key|^api.?key$/i;
const CONNSTRING_KEY_RE = /connection.?string|^database_url$|^db_(url|host|dsn)$/i;
const BUS_RE = /event.?bus|rabbit|amqp|kafka|nats(?![a-z])|servicebus/i;
const CACHE_RE = /redis|memcach|valkey|keydb/i;
const EXTERNAL_KEY_RE = /(url|uri|baseurl|base_url|endpoint|issuer|host)$/i;
/** Placeholder vars that are credentials/coordinates, not database identity. */
const CREDENTIAL_VAR_RE = /(^|_)(user|users|username|password|pass|pwd|secret|host|port|server)$/i;

/**
 * Logical database name from a connection var: `PLAN_DB_CONNECTIONSTRING` →
 * `plan`. Separators include `-`/`.` because k8s secret references synthesize
 * placeholders like `${user-api-db.connection-string}`.
 */
function dbNameFromVar(varName: string): string | undefined {
  const name = varName
    .replace(/[-_.]?(db)?[-_.]?connection[-_.]?string$/i, "")
    .replace(/[-_.]?db$/i, "")
    .toLowerCase();
  if (!name || name.length < 2 || CREDENTIAL_VAR_RE.test(name)) return undefined;
  return name;
}

/**
 * Logical database name from a literal connection string, when stated
 * (`Database=plan`, `initial catalog=tea_auth`, `postgres://host/dbname`).
 * Firebird catalogs can be file paths — those reduce to the file's basename.
 */
function dbNameFromLiteral(value: string): string | undefined {
  const kv = value.match(/(?:database|initial catalog|dbname)\s*=\s*([^;,'"]+)/i);
  let raw = kv?.[1]?.trim();
  if (!raw) {
    const url = value.match(/^[a-z+]+:\/\/[^/]+\/([A-Za-z0-9_-]+)/i);
    raw = url?.[1];
  }
  if (!raw) return undefined;
  if (PLACEHOLDER_RE.test(raw)) return undefined;
  if (/[/\\]/.test(raw)) {
    const base = raw.split(/[/\\]/).pop() ?? "";
    raw = base.replace(/\.[A-Za-z0-9]+$/, "");
  }
  const name = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return name.length >= 2 ? name : undefined;
}

/** External-system display name from a var name: `SUBSTITUTIONS_PRO_API_URL` → `Substitutions Pro`. */
function externalNameFromVar(varName: string): string {
  const base = varName
    .replace(/_?(api)?_?(url|uri|baseurl|base_url|endpoint|issuer|host)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!base) return varName;
  return base
    .split(" ")
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** The host of the first `http(s)://` URL in a value, or undefined. */
function hostOf(value: string): string | undefined {
  const m = value.match(/https?:\/\/([^/\s:;,'"]+)/i);
  return m ? m[1] : undefined;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Inputs that let `detectDeployment` attach services to the sub-projects the
 * analysis already found.
 */
export interface DetectDeploymentOptions {
  subProjects: SubProject[];
  /** Owning project per analyzed file — used to break project-match ties. */
  fileProjects?: Record<string, string>;
  /** Cap on compose files parsed (defensive; monorepos can vendor examples). */
  maxFiles?: number;
}

/**
 * Build the deployment topology from the repo's compose and Kubernetes/Helm
 * manifests.
 *
 * Compose files are found by name (`*compose*.yml`), non-runtime stacks are
 * excluded by path token, base manifests are read before environment variants,
 * and services are deduped by name as the module comment describes. Each
 * service is matched to a sub-project (by build context, image or name) and
 * classified as app, datastore, queue, …; `depends_on`, env URLs and
 * ports become edges.
 *
 * @param projectRoot - Directory to search
 * @param options - Sub-projects to match against, and the file cap
 * @returns The model, or undefined when the repo declares no runtime services
 */
export async function detectDeployment(
  projectRoot: string,
  options: DetectDeploymentOptions,
): Promise<DeploymentModel | undefined> {
  const absRoot = resolve(projectRoot);
  const found = await glob(["**/*compose*.{yml,yaml}"], {
    cwd: absRoot,
    ignore: IGNORE,
    absolute: false,
    caseSensitiveMatch: false,
    deep: 5,
  });

  const runtime = found
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.split("/").every((seg) => !NON_RUNTIME_RE.test(seg)))
    // Base manifests first, environment variants after — the base declaration
    // of a service wins, variants only fill gaps.
    .sort((a, b) => {
      const va = VARIANT_RE.test(a.split("/").pop() ?? a) ? 1 : 0;
      const vb = VARIANT_RE.test(b.split("/").pop() ?? b) ? 1 : 0;
      return va - vb || byOrdinal(a, b);
    })
    .slice(0, options.maxFiles ?? 20);

  // ── parse: keep every per-file declaration AND a merged inventory ──
  /** Env key that lists the databases a datastore hosts. */
  const HOSTED_DBS_KEY_RE = /^[A-Z]+_(MULTIPLE_)?(INITDB_)?(DATABASES?|DB)$/i;

  const perFile: RawService[][] = [];
  const merged = new Map<string, RawService>(); // key: lowercased service name
  const declaredIn = new Map<string, Set<string>>(); // key: lowercased service name → compose files
  const usedFiles = new Set<string>();

  /** Fold one manifest's services into the per-file + merged inventories. */
  function mergeGroup(raws: RawService[], rel: string): void {
    perFile.push(raws);
    usedFiles.add(rel);
    for (const svc of raws) {
      const key = svc.name.toLowerCase();
      (declaredIn.get(key) ?? declaredIn.set(key, new Set()).get(key)!).add(rel);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...svc, env: { ...svc.env }, dependsOn: [...svc.dependsOn] });
        continue;
      }
      // A declaration that actually runs something beats a metadata-only one
      // (rancher-compose.yml carries scale/health but no image).
      if (!existing.image && !existing.entrypoint && (svc.image || svc.entrypoint)) {
        const prevEnv = existing.env;
        merged.set(key, { ...svc, name: existing.name, env: { ...svc.env }, dependsOn: [...svc.dependsOn] });
        for (const [k, v] of Object.entries(prevEnv)) {
          const cur = merged.get(key)!;
          if (!(k in cur.env)) cur.env[k] = v;
        }
        continue;
      }
      for (const [k, v] of Object.entries(svc.env)) {
        if (!(k in existing.env)) existing.env[k] = v;
        else if (HOSTED_DBS_KEY_RE.test(k) && existing.env[k] !== v) {
          // Different stacks can seed different database lists — union them.
          existing.env[k] = existing.env[k] + "," + v;
        }
      }
      if (!existing.image) existing.image = svc.image;
      if (!existing.entrypoint) existing.entrypoint = svc.entrypoint;
      for (const dep of svc.dependsOn) if (!existing.dependsOn.includes(dep)) existing.dependsOn.push(dep);
      for (const p of svc.ports ?? []) if (!(existing.ports ??= []).includes(p)) existing.ports.push(p);
      for (const a of svc.aliases ?? []) if (!(existing.aliases ??= []).includes(a)) existing.aliases.push(a);
    }
  }

  for (const rel of runtime) {
    let text: string;
    try {
      text = await readFile(join(absRoot, rel), "utf-8");
    } catch {
      continue;
    }
    if (text.length > 1_000_000) continue;
    const raws = collectRawServices(parseSimpleYaml(text), rel);
    if (raws.length === 0) continue;
    mergeGroup(raws, rel);
  }

  // k8s / Helm manifests feed the same inventory — each manifest file is a
  // stack scope, workloads arrive pre-shaped as RawService.
  const k8s = await collectK8sManifests(absRoot);
  if (k8s) {
    for (let i = 0; i < k8s.groups.length; i++) mergeGroup(k8s.groups[i]!, k8s.files[i]!);
  }
  // Terraform modules too: Lambdas, queues, tables, databases (deployment-terraform.ts).
  const terraform = await collectTerraform(absRoot, IGNORE);
  if (terraform) {
    for (let i = 0; i < terraform.groups.length; i++) mergeGroup(terraform.groups[i]!, terraform.files[i]!);
  }

  // Each built service's Dockerfile: the command when compose states none, its ENV under compose's.
  const repo = repoFiles(absRoot);
  const referenced = new Set<string>();
  for (const svc of merged.values()) {
    if (!svc.build) continue;
    const df = posix.normalize(posix.join(svc.build.context, svc.build.dockerfile ?? "Dockerfile"));
    referenced.add(df);
    const facts = readDockerfile(absRoot, df);
    if (!facts) continue;
    svc.docker = facts;
    if (!svc.entrypoint && facts.command) svc.entrypoint = facts.command;
    for (const [k, v] of Object.entries(facts.env)) if (!(k in svc.env)) svc.env[k] = v;
  }
  // A Dockerfile no compose file builds is a deployable unit of its own, named after its directory.
  for (const df of await standaloneDockerfiles(absRoot)) {
    if (referenced.has(df)) continue;
    const facts = readDockerfile(absRoot, df);
    if (!facts?.command) continue;
    const context = posix.dirname(df) === "." ? "" : posix.dirname(df);
    const name = (context ? context.split("/").pop()! : posix.basename(absRoot)).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
    if (merged.has(name)) continue;
    merged.set(name, { name, file: df, entrypoint: facts.command, env: { ...facts.env }, dependsOn: [], ports: [], build: { context }, docker: facts });
    declaredIn.set(name, new Set([df]));
  }

  const rawMerged = [...merged.values()];
  if (rawMerged.length === 0) return undefined;

  const fileCounts = new Map<string, number>();
  for (const pid of Object.values(options.fileProjects ?? {})) {
    fileCounts.set(pid, (fileCounts.get(pid) ?? 0) + 1);
  }
  const projects = indexProjects(options.subProjects);
  // Ambiguity (two projects normalizing alike, e.g. an old and a new copy of a
  // SPA) resolves to the one that owns more analyzed files.
  const byFiles = (cands: SubProject[] | undefined): string | undefined => {
    if (!cands || cands.length === 0) return undefined;
    return cands
      .slice()
      .sort((a, b) => (fileCounts.get(b.id) ?? 0) - (fileCounts.get(a.id) ?? 0))[0].id;
  };

  // ── classify + match ──
  const services: DeployedService[] = rawMerged.map((svc) => {
    const { kind, family } = classify(svc);
    const artifact = entryArtifact(svc.entrypoint);
    const s: DeployedService = {
      name: svc.name,
      composeFile: svc.file,
      composeFiles: [...(declaredIn.get(svc.name.toLowerCase()) ?? [svc.file])].sort(),
      image: svc.image,
      entrypoint: svc.entrypoint,
      kind,
      family,
      tech: artifact ?? imageTail(svc.image),
    };
    if (svc.docker) s.dockerfile = svc.docker.dockerfile;
    if (svc.env && Object.keys(svc.env).length) s.envKeys = Object.keys(svc.env).sort(byOrdinal);
    if (kind === "app") {
      // The build context is the strongest evidence of what a service runs.
      s.project = (svc.build ? projectOfContext(svc.build.context, options.subProjects) : undefined) ?? matchProject(svc, projects, byFiles);
      const entryFile = svc.entryFile ?? (svc.build ? entryFileOf(svc.entrypoint, svc.build.context, repo) : undefined);
      if (entryFile) s.entryFile = entryFile;
      // Where the service is told other services are — URL-shaped values only.
      const urlEnv: Record<string, string> = {};
      for (const k of Object.keys(svc.env).sort(byOrdinal)) {
        const url = urlValue(svc.env[k]!);
        if (url) urlEnv[k] = url;
      }
      if (Object.keys(urlEnv).length) s.urlEnv = urlEnv;
      if (svc.ports?.length) s.hostPorts = [...svc.ports].sort((a, b) => a - b);
      if (svc.aliases?.length) s.aliases = [...new Set(svc.aliases)].sort(byOrdinal);
      const envText = Object.entries(svc.env).map(([k, v]) => k + "=" + v);
      s.bus = envText.some((e) => BUS_RE.test(e)) || undefined;
      s.cache = envText.some((e) => CACHE_RE.test(e)) || undefined;
    } else {
      const hosted = new Set<string>();
      for (const [k, v] of Object.entries(svc.env)) {
        if (HOSTED_DBS_KEY_RE.test(k) && v && !PLACEHOLDER_RE.test(v)) {
          for (const d of v.split(",")) {
            const t = d.trim().toLowerCase();
            if (t) hosted.add(t);
          }
        }
      }
      if (hosted.size) s.hostedDatabases = [...hosted];
    }
    return s;
  });

  const svcByLower = new Map(services.map((s) => [s.name.toLowerCase(), s]));
  const normToService = new Map<string, string>();
  for (const s of services) {
    if (s.kind === "app") normToService.set(normName(s.name), s.name);
  }
  // k8s Service DNS aliases: env URLs point at the Service name, the workload
  // may be named differently — resolve the alias onto the workload it selects.
  for (const [alias, target] of k8s?.aliases ?? []) {
    const svc = svcByLower.get(target.toLowerCase());
    if (svc && svc.kind === "app" && !normToService.has(normName(alias))) {
      normToService.set(normName(alias), svc.name);
    }
    if (svc && svc.kind === "app" && alias.toLowerCase() !== svc.name.toLowerCase()) {
      svc.aliases = [...new Set([...(svc.aliases ?? []), alias])].sort(byOrdinal);
    }
  }

  /** App service whose normalized name shares the longest (≥4 char) prefix relation with `norm`. */
  function serviceByNormPrefix(norm: string): string | undefined {
    let best: string | undefined;
    let bestLen = 3;
    for (const [n, name] of normToService) {
      if (norm.startsWith(n) || n.startsWith(norm)) {
        const len = Math.min(n.length, norm.length);
        if (len > bestLen) { best = name; bestLen = len; }
      }
    }
    return best;
  }

  const edges: DeploymentEdge[] = [];
  const edgeSeen = new Set<string>();
  function addEdge(e: DeploymentEdge): void {
    if (e.from.toLowerCase() === e.to.toLowerCase()) return;
    // Label participates in identity so one service reaching N logical
    // databases on the same host keeps N edges.
    const key = e.from.toLowerCase() + "|" + e.to.toLowerCase() + "|" + e.kind + "|" + (e.label ?? "");
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push(e);
  }
  /** Canonical (merged) service name for a raw per-file name. */
  const canon = (name: string): string => svcByLower.get(name.toLowerCase())?.name ?? name;

  // ── API-key handshake, PER FILE (key vars are stack-scoped) ──
  for (const raws of perFile) {
    const providersByVar = new Map<string, string[]>();
    for (const svc of raws) {
      if (svcByLower.get(svc.name.toLowerCase())?.kind !== "app") continue;
      for (const [k, v] of Object.entries(svc.env)) {
        const ph = v.match(PLACEHOLDER_RE);
        if (ph && AUTH_PROVIDER_KEY_RE.test(k)) {
          (providersByVar.get(ph[1]) ?? providersByVar.set(ph[1], []).get(ph[1])!).push(svc.name);
        }
      }
    }
    if (providersByVar.size === 0) continue;
    for (const svc of raws) {
      if (svcByLower.get(svc.name.toLowerCase())?.kind !== "app") continue;
      for (const [k, v] of Object.entries(svc.env)) {
        const ph = v.match(PLACEHOLDER_RE);
        if (!ph) continue;
        const providers = providersByVar.get(ph[1]);
        if (!providers) continue;
        if (AUTH_PROVIDER_KEY_RE.test(k)) continue; // the provider holding its own key
        for (const p of providers) addEdge({ from: canon(svc.name), to: canon(p), kind: "http", via: ph[1] });
      }
    }
  }

  // ── connection strings, bus/cache attachment, URLs (merged env) ──
  const datastores = services.filter((s) => s.kind === "datastore");
  const queues = services.filter((s) => s.kind === "queue");
  const externals = new Map<string, DeploymentExternal>();

  function storeHosting(dbName: string): string | undefined {
    const norm = normName(dbName);
    for (const ds of datastores) {
      if ((ds.hostedDatabases ?? []).some((h) => norm === normName(h) || norm.startsWith(normName(h)))) {
        return ds.name;
      }
    }
    return undefined;
  }

  function addExternal(name: string, url: string | undefined, from: string, via: string): void {
    const id = "ext:" + normName(name);
    if (!externals.has(id)) externals.set(id, { id, name, url });
    else if (url && !externals.get(id)!.url) externals.get(id)!.url = url;
    addEdge({ from, to: id, kind: "external", label: url ? hostOf(url) : undefined, via });
  }

  for (const svc of rawMerged) {
    const s = svcByLower.get(svc.name.toLowerCase());
    if (!s || s.kind !== "app") continue;

    for (const [k, v] of Object.entries(svc.env)) {
      const ph = v.match(PLACEHOLDER_RE);
      const phName = ph ? ph[1] : "";

      // Connection strings → logical db + owning datastore. Cache/bus
      // connection strings are attachments, not databases.
      if (CONNSTRING_KEY_RE.test(k)) {
        if (CACHE_RE.test(k) || CACHE_RE.test(phName) || BUS_RE.test(k) || BUS_RE.test(phName)) continue;
        // Literal `Database=` beats placeholder-name inference: values often
        // interpolate only credentials (`User ID=${DB_User};Database=plan`).
        let dbName = dbNameFromLiteral(v);
        if (!dbName) {
          for (const m of v.matchAll(PLACEHOLDER_ALL_RE)) {
            if (CREDENTIAL_VAR_RE.test(m[1])) continue;
            dbName = dbNameFromVar(m[1]);
            if (dbName) break;
          }
        }
        if (!dbName) continue;
        const primary = /^connection_?string$/i.test(k) || /^(database_url|db_url|db_dsn)$/i.test(k);
        if (!s.databases) s.databases = [];
        const existing = s.databases.find((d) => d.name === dbName);
        if (existing) existing.primary = existing.primary || primary;
        else s.databases.push({ name: dbName, primary });
        const host = storeHosting(dbName);
        if (host) addEdge({ from: svc.name, to: host, kind: "db", label: dbName, via: ph ? ph[1] : k });
        continue;
      }

      // A key not named like a URL whose value is one, naming another service:
      // .NET configuration overrides are named after the section they set
      // (`Services__Inventory: http://inventory:8080`). An edge only — an
      // arbitrary key's unknown host is not evidence of an external system.
      if (!EXTERNAL_KEY_RE.test(k) && /^https?:\/\//i.test(v)) {
        const host = hostOf(v);
        const target = host ? normToService.get(normName(host.split(".")[0]!)) : undefined;
        if (target) addEdge({ from: svc.name, to: target, kind: "http", via: k });
        continue;
      }

      // URLs / issuers: another compose service (→ http edge) or an external.
      if (EXTERNAL_KEY_RE.test(k)) {
        // Bus/cache endpoints are attachments, not HTTP dependencies.
        if (/^(amqps?|kafka|redis):\/\//i.test(v)) continue;
        if (BUS_RE.test(phName) || CACHE_RE.test(phName)) continue;
        if (!ph && (BUS_RE.test(k) || CACHE_RE.test(k)) && !/^https?:\/\//i.test(v)) continue;

        // Token issuers are external identity systems by nature — never map
        // them onto a similarly-named internal service (a cache/proxy of the
        // external often shares its name).
        const isIssuer = /issuer$/i.test(k) || /issuer$/i.test(phName);
        // A `*_PROXY_URL` names the system's own front door (SPA dev proxy,
        // reverse proxy), not an external system — it may still resolve to an
        // internal service, but never becomes an external node.
        const isProxy = /proxy/i.test(k) || /proxy/i.test(phName);

        const literalHost = hostOf(v);
        if (literalHost) {
          const keyName = externalNameFromVar(k);
          const target = isIssuer ? undefined : normToService.get(normName(literalHost.split(".")[0]));
          if (target) addEdge({ from: svc.name, to: target, kind: "http", via: k });
          else if (!isProxy) {
            const display = keyName !== k && keyName.length >= 3 ? keyName : literalHost;
            addExternal(display, v.match(/https?:\/\/[^\s'";,]+/i)?.[0], svc.name, k);
          }
          continue;
        }
        if (!ph) {
          // Bare service reference: `SOME_API_HOST: leaguedata-api`.
          const target = normToService.get(normName(v));
          if (target) addEdge({ from: svc.name, to: target, kind: "http", via: k });
          continue;
        }
        const derived = externalNameFromVar(ph[1]);
        const target = isIssuer
          ? undefined
          : serviceByNormPrefix(normName(derived)) ?? serviceByNormPrefix(normName(k.replace(/_?(url|uri|baseurl|base_url|endpoint|issuer|host)$/i, "")));
        if (target) addEdge({ from: svc.name, to: target, kind: "http", via: ph[1] });
        else if (!isProxy) addExternal(derived, undefined, svc.name, ph[1]);
      }
    }

    // Bus attachment → edge to the (first) queue service.
    if (s.bus && queues.length > 0) {
      addEdge({ from: svc.name, to: queues[0].name, kind: "bus" });
    }
  }

  // ── k8s Ingress edges: front door → the workload each rule routes to ──
  for (const e of terraform?.edges ?? []) {
    if (svcByLower.has(e.from.toLowerCase()) && svcByLower.has(e.to.toLowerCase())) addEdge({ from: canon(e.from), to: canon(e.to), kind: e.kind, via: e.via });
  }
  for (const e of k8s?.ingressEdges ?? []) {
    const target = k8s?.aliases.get(e.to) ?? e.to;
    if (!svcByLower.has(target.toLowerCase())) continue;
    addEdge({ from: canon(e.from), to: canon(target), kind: "http", label: e.host, via: "ingress" });
  }

  // ── depends_on (weakest evidence; only for pairs with no better edge) ──
  const pairHasEdge = new Set(edges.map((e) => e.from.toLowerCase() + "|" + e.to.toLowerCase()));
  for (const svc of rawMerged) {
    for (const dep of svc.dependsOn) {
      const target = canon(dep);
      if (!svcByLower.has(target.toLowerCase())) continue;
      if (pairHasEdge.has(svc.name.toLowerCase() + "|" + target.toLowerCase())) continue;
      addEdge({ from: svc.name, to: target, kind: "depends" });
    }
  }

  return {
    composeFiles: [...usedFiles].sort(),
    services,
    externals: [...externals.values()].sort((a, b) => byOrdinal(a.name, b.name)),
    edges,
  };
}
