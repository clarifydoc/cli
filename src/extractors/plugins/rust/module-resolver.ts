import type { ImportResolveContext } from "../../../types/language-plugin.js";

/**
 * Where a Rust `use` path's module lives, so a call to an imported function
 * (`use crate::util::{is_hidden}` … `is_hidden(p)`) reaches the file that
 * defines it:
 *   - `crate::a::b`   — under the importing crate's `src/` (its `lib.rs` / `main.rs`
 *     directory): `a/b.rs` or `a/b/mod.rs`;
 *   - `self::x`, `super::x` — beside / above the importing module;
 *   - `other_crate::m` — a workspace crate whose directory is named so
 *     (`-` for `_`): `other-crate/src/m.rs`;
 *   - a module that does not declare the name but glob-re-exports a child
 *     (`pub use chat_sql::*` in `persistence/mod.rs`) answers with that child.
 * A name the module path itself ends with (`use crate::util::is_hidden` written as
 * one path) is tried as the item of its parent module too. Leaf code.
 */
export function resolveRustImport(importingFile: string, source: string, specifier: string | undefined, ctx: ImportResolveContext): string | null {
  const segs = source.split("::").filter((s) => s && s !== "*");
  if (segs.length === 0) return null;
  let base = moduleDirOf(importingFile, segs[0]!, ctx);
  let rest = segs.slice(1);
  // Neither a path keyword nor a crate: a child module of the importing one (`pub use club_sql::*` in `persistence/mod.rs`).
  if (base === null) {
    base = selfDirOf(importingFile);
    rest = segs;
    if (!ctx.files.has(join(base, `${segs[0]}.rs`)) && !ctx.files.has(join(base, `${segs[0]}/mod.rs`))) return null;
  }
  // `super::super::x`: each `super` one module — one directory — up.
  const up = (d: string) => (d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "");
  let dir = segs[0] === "super" ? up(base) : base;
  let path = rest;
  while (segs[0] === "super" && path[0] === "super") {
    dir = up(dir);
    path = path.slice(1);
  }
  const module = moduleFile(dir, path, ctx);
  if (!module) return null;
  if (!specifier || ctx.declares(module, specifier)) return module;
  // `pub use chat_sql::*` — the module re-exports a child's items.
  for (const glob of ctx.globImportsOf(module)) {
    const child = resolveRustImport(module, glob.replace(/::\*$/, ""), undefined, ctx);
    if (child && child !== module && ctx.declares(child, specifier)) return child;
  }
  return module;
}

/** The directory a path's first segment starts from; null when it names no project crate. */
function moduleDirOf(importingFile: string, head: string, ctx: ImportResolveContext): string | null {
  if (head === "crate") return crateSrcOf(importingFile, ctx);
  if (head === "self" || head === "super") return selfDirOf(importingFile);
  // A sibling module named outright from the crate root (2018 edition paths in a `mod.rs`/`lib.rs`).
  return workspaceCrate(head, ctx);
}

/** The `src/` directory of the crate the file belongs to: the nearest ancestor holding `lib.rs` or `main.rs`. */
function crateSrcOf(file: string, ctx: ImportResolveContext): string | null {
  let dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  for (;;) {
    if (ctx.files.has(join(dir, "lib.rs")) || ctx.files.has(join(dir, "main.rs"))) return dir;
    if (dir === "") return null;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
}

/** The directory a file's own child modules live in: `a/b.rs` → `a/b`, `a/mod.rs` / `lib.rs` → `a`. */
function selfDirOf(file: string): string {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.rs$/, "");
  return base === "mod" || base === "lib" || base === "main" ? dir : join(dir, base);
}

const crateIndex = new WeakMap<ReadonlySet<string>, Map<string, string | null>>();

/** A workspace crate by its name (`flowy_ai_pub` → `…/flowy-ai-pub/src`); null when absent or two crates share it. */
function workspaceCrate(name: string, ctx: ImportResolveContext): string | null {
  let index = crateIndex.get(ctx.files);
  if (!index) {
    index = new Map();
    for (const f of ctx.files) {
      const m = /^(?:(.*)\/)?([^/]+)\/src\/lib\.rs$/.exec(f);
      if (!m) continue;
      const key = m[2]!.replace(/-/g, "_");
      const src = (m[1] ? `${m[1]}/` : "") + `${m[2]}/src`;
      index.set(key, index.has(key) ? null : src);
    }
    crateIndex.set(ctx.files, index);
  }
  return index.get(name) ?? null;
}

/** `a/b.rs` or `a/b/mod.rs` under `dir`; the directory's own `lib.rs`/`mod.rs` for an empty path. */
function moduleFile(dir: string, path: string[], ctx: ImportResolveContext): string | null {
  if (path.length === 0) {
    for (const f of ["lib.rs", "mod.rs", "main.rs"]) if (ctx.files.has(join(dir, f))) return join(dir, f);
    return null;
  }
  const rel = path.join("/");
  for (const f of [`${rel}.rs`, `${rel}/mod.rs`]) if (ctx.files.has(join(dir, f))) return join(dir, f);
  // The last segment is an item, not a module (`use crate::util::is_hidden`).
  return path.length > 1 ? moduleFile(dir, path.slice(0, -1), ctx) : moduleFile(dir, [], ctx);
}

const join = (dir: string, f: string): string => (dir ? `${dir}/${f}` : f);
