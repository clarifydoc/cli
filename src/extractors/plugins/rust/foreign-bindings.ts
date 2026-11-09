import type { ForeignBindingRule } from "../../../types/analysis.js";

/**
 * Rust libraries other languages call through generated bindings, as the
 * generator's own configuration states them (core joins the calls,
 * `foreign-bindings.ts`):
 *
 *   - flutter_rust_bridge (`flutter_rust_bridge.yaml` beside a Flutter app's
 *     pubspec): each module of `rust_input` — `crate::api` under `rust_root`,
 *     or another crate by its package name — is written to `dart_output`
 *     (`lib/src/rust/api/clubs.dart`, `lib/src/rust/third_party/club_kit/clubs.dart`),
 *     its public functions in lowerCamelCase;
 *   - wasm-bindgen through wasm-pack (a `wasm-pack build <crate> --out-dir <dir>`
 *     script in a package.json, possibly after `cd <crate> &&`): the crate's
 *     `#[wasm_bindgen]` functions, and those of the project crates it links
 *     (`use club_kit as _;`), named by `js_name` when it says so, in the one
 *     module `<dir>/<crate_name>.js`.
 *
 * Leaf code: reads only its arguments.
 */
export function rustForeignBindings(root: string, read: (path: string) => string | undefined, files: ReadonlySet<string>): ForeignBindingRule[] {
  return [...flutterRustBridge(root, read, files), ...wasmPack(root, read, files)];
}

function join(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    for (const seg of part.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length === 0 || out.at(-1) === "..") out.push("..");
        else out.pop();
      } else out.push(seg);
    }
  }
  return out.join("/");
}

const crateName = (name: string) => name.replace(/-/g, "_");

/** Top-level `key: value` pairs of a flat YAML file; a value written as a list (`- a`) joins its items with commas. */
function flatYaml(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let listKey: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item && listKey) {
      const prev = out.get(listKey);
      out.set(listKey, prev ? `${prev},${unquote(item[1]!)}` : unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z_]\w*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) {
      if (/^\S/.test(line)) listKey = null;
      continue;
    }
    listKey = kv[2] ? null : kv[1]!;
    if (kv[2] && kv[2] !== "|" && kv[2] !== ">") out.set(kv[1]!, unquote(kv[2]));
  }
  return out;
}

const unquote = (v: string) => v.replace(/^(['"])(.*)\1$/, "$2");

/** The `[package] name` a Cargo.toml declares. */
function packageName(toml: string | undefined): string | null {
  if (!toml) return null;
  const section = /^\s*\[package\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
}

/** The entry for `name` in a TOML section (`club-kit = { path = "../kit" }`, `club-kit.workspace = true`). */
function dependencyEntry(toml: string, section: string, name: string): string | null {
  const body = new RegExp(`^\\s*\\[${section.replace(/\./g, "\\.")}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, "m").exec(toml)?.[1];
  if (!body) return null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*([\w-]+)(\.workspace)?\s*=\s*(.*)$/.exec(line);
    if (m && crateName(m[1]!) === crateName(name)) return m[2] ? "{ workspace = true }" : m[3]!;
  }
  return null;
}

/** The directory of the crate `name` a crate depends on: its `path`, through the workspace's when it says `workspace = true`. */
function dependencyDir(crateDir: string, name: string, read: (path: string) => string | undefined, files: ReadonlySet<string>): string | null {
  const stated = pathDependencyDir(crateDir, name, read);
  if (stated !== undefined) return stated;
  // Else the ONE analyzed crate whose Cargo.toml declares that package name.
  const hits = new Set<string>();
  for (const f of files) {
    const m = /^(?:(.*)\/)?src\/lib\.rs$/.exec(f);
    if (m && crateName(packageName(read(join(m[1] ?? "", "Cargo.toml"))) ?? "") === crateName(name)) hits.add(m[1] ?? "");
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

/**
 * The directory a crate's Cargo.toml gives its dependency `name`: its `path`, or the workspace's for
 * `workspace = true` (null when the workspace names no path); undefined when neither says.
 */
function pathDependencyDir(crateDir: string, name: string, read: (path: string) => string | undefined): string | null | undefined {
  const own = read(join(crateDir, "Cargo.toml"));
  const entry = own ? dependencyEntry(own, "dependencies", name) : null;
  const path = (e: string | null) => (e ? /\bpath\s*=\s*"([^"]+)"/.exec(e)?.[1] : undefined);
  const direct = path(entry);
  if (direct) return join(crateDir, direct);
  if (entry && /\bworkspace\s*=\s*true\b/.test(entry)) {
    for (let dir = crateDir; ; dir = join(dir, "..")) {
      const toml = read(join(dir, "Cargo.toml"));
      if (toml && /^\s*\[workspace\]\s*$/m.test(toml)) {
        const p = path(dependencyEntry(toml, "workspace.dependencies", name));
        return p ? join(dir, p) : null;
      }
      if (dir === "" || dir.startsWith("..")) break;
    }
  }
  return undefined;
}

function flutterRustBridge(root: string, read: (path: string) => string | undefined, files: ReadonlySet<string>): ForeignBindingRule[] {
  const text = read(join(root, "flutter_rust_bridge.yaml"));
  if (text === undefined) return [];
  const config = flatYaml(text);
  const rustRoot = join(root, config.get("rust_root") ?? "rust");
  const dartOutput = join(config.get("dart_output") ?? "lib/src/rust");
  const dartPackage = /^name\s*:\s*([\w-]+)/m.exec(read(join(root, "pubspec.yaml")) ?? "")?.[1];
  // `package:club/src/rust/…` names `lib/src/rust/…` of the package `club`.
  const prefix = (rel: string) => (dartPackage && dartOutput.startsWith("lib/") ? join(`package:${dartPackage}`, dartOutput.slice(4), rel) : undefined);
  const rules: ForeignBindingRule[] = [];
  const rule = (source: string, rel: string): ForeignBindingRule => {
    const importPrefix = prefix(rel);
    return {
      tool: "flutter_rust_bridge",
      source,
      sourceExtension: ".rs",
      indexFiles: ["mod.rs", "lib.rs"],
      output: join(root, dartOutput, rel),
      outputExtension: ".dart",
      ...(importPrefix ? { importPrefix } : {}),
      rename: "camel",
      decorator: { name: "frb", required: false, renameArgument: "name", skipArgument: "ignore" },
    };
  };
  for (const input of (config.get("rust_input") ?? "crate::api").split(",").map((s) => s.trim()).filter(Boolean)) {
    const segs = input.split("::");
    if (segs[0] === "crate") {
      rules.push(rule(join(rustRoot, "src", ...segs.slice(1)), segs.slice(1).join("/")));
      continue;
    }
    // Another crate the bridge's crate depends on: written under `third_party/<crate_name>/`.
    const dir = dependencyDir(rustRoot, segs[0]!, read, files);
    if (dir !== null) rules.push(rule(join(dir, "src", ...segs.slice(1)), join("third_party", crateName(segs[0]!), ...segs.slice(1))));
  }
  return rules;
}

const WASM_PACK = /\bwasm-pack\s+build\b([^&|;]*)/g;

function wasmPack(root: string, read: (path: string) => string | undefined, files: ReadonlySet<string>): ForeignBindingRule[] {
  const text = read(join(root, "package.json"));
  if (!text?.includes("wasm-pack")) return [];
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  const rules: ForeignBindingRule[] = [];
  for (const script of Object.values(scripts)) {
    if (typeof script !== "string") continue;
    for (const m of script.matchAll(WASM_PACK)) {
      const tokens = m[1]!.trim().split(/\s+/).filter(Boolean);
      let crate = ".";
      let outDir = "pkg";
      let outName: string | undefined;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t === "--out-dir" || t === "-d") outDir = tokens[++i] ?? outDir;
        else if (t === "--out-name") outName = tokens[++i];
        else if (t === "--target" || t === "-t" || t === "--scope" || t === "-s" || t === "--mode" || t === "--profile") i++;
        else if (!t.startsWith("-") && crate === ".") crate = t;
      }
      // `cd ../crates/club && wasm-pack build .`: the crate path is read from the directory the script moved to.
      const moved = /\bcd\s+([^\s&|;]+)\s*&&\s*$/.exec(script.slice(0, m.index))?.[1];
      const crateDir = join(root, moved ?? "", crate);
      const name = packageName(read(join(crateDir, "Cargo.toml")));
      if (!name || !files.has(join(crateDir, "src/lib.rs"))) continue;
      // wasm-pack writes `--out-dir` relative to the crate.
      const output = join(crateDir, outDir, outName ?? crateName(name));
      for (const dir of [crateDir, ...linkedCrates(crateDir, read, files)]) {
        rules.push({
          tool: "wasm-bindgen",
          source: join(dir, "src"),
          sourceExtension: ".rs",
          indexFiles: ["mod.rs", "lib.rs"],
          output,
          outputExtension: ".js",
          single: true,
          rename: "same",
          decorator: { name: "wasm_bindgen", required: true, renameArgument: "js_name", skipArgument: "skip" },
        });
      }
    }
  }
  return rules;
}

const MAX_LINKED_CRATES = 16;

/**
 * The project's own crates linked into a wasm crate, whose `#[wasm_bindgen]` functions the generated module
 * exports too: each `[dependencies]` entry with a `path` (directly or through the workspace) that the crate's
 * sources name (`use club_kit as _;`, `club_kit::renew()` — a dependency nothing names is not linked), and in
 * turn the ones those name.
 */
function linkedCrates(crateDir: string, read: (path: string) => string | undefined, files: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set([crateDir]);
  const queue = [crateDir];
  while (queue.length > 0 && out.length < MAX_LINKED_CRATES) {
    const dir = queue.shift()!;
    const toml = read(join(dir, "Cargo.toml"));
    const body = toml ? /^\s*\[dependencies\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(toml)?.[1] : undefined;
    if (!body) continue;
    const prefix = `${join(dir, "src")}/`;
    const sources = [...files].filter((f) => f.startsWith(prefix) && f.endsWith(".rs")).map((f) => read(f) ?? "");
    for (const line of body.split(/\r?\n/)) {
      const dep = /^\s*([\w-]+)(?:\.workspace\s*=\s*true|\s*=\s*\{[^}]*\b(?:path|workspace)\s*=)/.exec(line)?.[1];
      if (!dep) continue;
      const named = new RegExp(`\\b${crateName(dep)}\\s*(?:::|as\\b|;)`);
      if (!sources.some((text) => named.test(text))) continue;
      const depDir = pathDependencyDir(dir, dep, read);
      if (!depDir || seen.has(depDir) || !files.has(join(depDir, "src/lib.rs"))) continue;
      seen.add(depDir);
      out.push(depDir);
      queue.push(depDir);
    }
  }
  return out;
}
