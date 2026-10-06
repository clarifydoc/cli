import { readFile } from "fs/promises";
import { join } from "path";
import type { FileAnalysis } from "../../../types/analysis.js";
import type {
  ReachabilityHooks,
  ReachabilityLoadContext,
  ReachabilityModel,
} from "../../../types/language-plugin.js";

/**
 * How Cargo finds Rust files — the model dead-code analysis walks.
 *
 * Rust is the precise case: the compiler builds a crate from its root file
 * (`src/main.rs`, `src/lib.rs`, `src/bin/*.rs`, `tests/*.rs`, …) by following
 * `mod x;` declarations, and a `.rs` file no declaration reaches is not
 * compiled at all. `use` never loads a file — it names items in modules that
 * `mod` already declared — so it resolves to nothing here (the component
 * graph's `use` edges still count, which only adds reachability).
 *
 * Per-file references come from {@link extractRustModuleRefs}, in this
 * dialect: `mod:<name>` (a `mod name;`, nested under inline modules as
 * `mod:outer/name`) and `path:<file>` (`#[path = "…"]`, `include!("…")`),
 * the latter relative to the declaring file's directory.
 */

/** Crate-root files Cargo discovers by convention, relative to the crate. */
const CRATE_ROOT_RE =
  /^(?:src\/(?:main|lib)\.rs|src\/bin\/[^/]+\.rs|src\/bin\/[^/]+\/main\.rs|(?:examples|tests|benches)\/[^/]+\.rs|(?:examples|tests|benches)\/[^/]+\/main\.rs|build\.rs)$/;

export const rustReachability: ReachabilityHooks = { load: loadRustReachability };

async function loadRustReachability(ctx: ReachabilityLoadContext): Promise<ReachabilityModel> {
  const files = ctx.files;
  // Crates: project roots holding a Cargo.toml, innermost first.
  const crates: string[] = [];
  const manifestEntries: Array<{ file: string; reason: string }> = [];
  for (const root of [...new Set(["", ...ctx.roots])]) {
    const toml = await readText(join(ctx.projectRoot, root, "Cargo.toml"));
    if (toml === null) continue;
    crates.push(root);
    // `[[bin]] path = "…"`, `[lib] path`, `[[example]]`/`[[test]]`/`[[bench]]`
    // paths and a custom `build = "…"` script.
    for (const m of toml.matchAll(/^\s*(path|build)\s*=\s*"([^"]+\.rs)"/gm)) {
      const file = normalize(root ? `${root}/${m[2]}` : m[2]!);
      if (files.has(file)) manifestEntries.push({ file, reason: `Cargo.toml ${m[1]}` });
    }
  }
  crates.sort((a, b) => b.length - a.length);
  manifestEntries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const manifestFiles = new Set(manifestEntries.map((e) => e.file));

  const crateOf = (file: string): string | undefined =>
    crates.find((c) => c === "" || file.startsWith(c + "/"));
  const crateRootReason = (file: string): string | null => {
    if (manifestFiles.has(file)) return "Cargo.toml target";
    const crate = crateOf(file);
    if (crate === undefined) return null;
    const rel = crate ? file.slice(crate.length + 1) : file;
    return CRATE_ROOT_RE.test(rel) ? "Cargo crate root" : null;
  };

  return {
    manifestEntries,
    judgeExports: false,

    entryReason(analysis: FileAnalysis): string | null {
      const reason = crateRootReason(analysis.filePath);
      return reason && !/(?:^|\/)build\.rs$/.test(analysis.filePath) ? reason : null;
    },

    // Cargo runs the build script; it is no evidence of where the program starts.
    passiveReason(analysis: FileAnalysis): string | null {
      return /(?:^|\/)build\.rs$/.test(analysis.filePath) && crateRootReason(analysis.filePath) ? "Cargo build script" : null;
    },

    // `use` names items, never files.
    resolve: () => [],

    resolvePath(fromFile: string, ref: string): string[] {
      const dir = dirOf(fromFile);
      if (ref.startsWith("path:")) {
        const hit = normalize(`${dir}/${ref.slice(5)}`);
        return files.has(hit) ? [hit] : [];
      }
      if (!ref.startsWith("mod:")) return [];
      // A crate root and a `mod.rs` declare their children beside themselves;
      // any other `foo.rs` declares them in `foo/`.
      const base = crateRootReason(fromFile) || /(?:^|\/)mod\.rs$/.test(fromFile)
        ? dir
        : `${dir ? `${dir}/` : ""}${fromFile.slice(dir ? dir.length + 1 : 0).replace(/\.rs$/, "")}`;
      const name = ref.slice(4);
      for (const candidate of [`${base}/${name}.rs`, `${base}/${name}/mod.rs`]) {
        const c = normalize(candidate);
        if (files.has(c)) return [c];
      }
      return [];
    },
  };
}

/**
 * `mod name;` declarations (not inline `mod name { … }` blocks), with the
 * inline modules they sit in, plus `#[path = "…"]` overrides and `include!`.
 */
export function extractRustModuleRefs(lines: string[]): string[] {
  const out: string[] = [];
  let pendingPath: string | null = null;
  // Inline modules currently open, with the brace depth each opened at.
  const inline: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  for (const raw of lines) {
    const line = stripCommentsAndStrings(raw).trim();
    const original = raw.trim();
    const attr = /#\[\s*path\s*=\s*"([^"]+)"\s*\]/.exec(original);
    if (attr) pendingPath = attr[1]!;
    const decl = /^(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(?:r#)?([A-Za-z_]\w*)\s*(;|\{)/.exec(line);
    if (decl) {
      if (decl[2] === ";") {
        const prefix = inline.map((m) => m.name).join("/");
        out.push(pendingPath ? `path:${pendingPath}` : `mod:${prefix ? `${prefix}/` : ""}${decl[1]}`);
      } else {
        inline.push({ name: decl[1]!, depth });
      }
      pendingPath = null;
    } else if (line && !line.startsWith("#[")) {
      // An attribute applies to the next item only.
      pendingPath = null;
    }
    for (const inc of original.matchAll(/\binclude!\s*\(\s*"([^"]+\.rs)"\s*\)/g)) out.push(`path:${inc[1]}`);
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        while (inline.length > 0 && depth <= inline[inline.length - 1]!.depth) inline.pop();
      }
    }
  }
  return [...new Set(out)];
}

/** Line comments and string/char literal bodies removed, so their braces don't count. */
function stripCommentsAndStrings(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)'/g, "''")
    .replace(/\/\/.*$/, "");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
