import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import type { FileAnalysis } from "../../../types/analysis.js";
import type {
  ReachabilityHooks,
  ReachabilityLoadContext,
  ReachabilityModel,
} from "../../../types/language-plugin.js";
import { findShebangScripts, SCRIPT_DIRS } from "./shebang-scripts.js";

/**
 * Builds a dead-code reachability model from a declarative spec — for the
 * languages whose files reach each other by NAME (C#, Java, PHP, Ruby
 * constants, C functions) or by a module path with a fixed file mapping
 * (`use A::B` → `A/B.pm`, `#include "x.h"`, `require "a.b"` → `a/b.lua`).
 * A plugin states its conventions; this file holds the mechanics:
 *
 *   - names: what a file declares (types, functions, its stem, a raw
 *     declaration regex as a backstop for extractor misses). Core reaches a
 *     file when reachable text mentions one of them.
 *   - imports: a module path is tried beside the importer, then as a path
 *     suffix anywhere in the project (every match counts — over-reaching only
 *     keeps code alive); nothing found means external.
 *   - entries: path conventions (optionally gated on a framework), `main`,
 *     framework attributes and base types, route-declaring files, source
 *     patterns (`@main`).
 *   - passive: files a tool runs (migrations, build scripts).
 *   - configuration: identifiers in manifests and config files the framework
 *     reads (AndroidManifest, appsettings, `.app.src`), plus extension-less
 *     `#!` scripts, become `configMentions`.
 */

export type PathRule = readonly [RegExp, string];

export interface ConventionSpec {
  /** Source extensions of the language (lowercase, with the dot). */
  extensions: readonly string[];
  /** Map an import source to a module path, or null when it names no file (a namespace). Default: none do. */
  importPath?(source: string): string | null;
  /** Match paths case-insensitively (Delphi units, PSR-4 `App\` ↔ `app/`). */
  caseInsensitive?: boolean;
  /** Files a directory-shaped module path resolves to (`init.lua`). */
  indexFiles?: readonly string[];
  /** What a file declares that others mention by name. Absent = names are not used. */
  names?: {
    types?: boolean;
    functions?: boolean;
    /** The file's basename without extension (module = file languages). */
    stem?: boolean;
    /** Raw-source declarations, group 1 = the name — a backstop for extractor misses. */
    declaration?: RegExp;
    /** Classes whose METHODS are called bare (C# `*Extensions`): their method names count too. */
    methodsOf?: RegExp;
  };
  /** Function/method names that start a program. */
  mainFunctions?: RegExp;
  /** Path conventions (relative to the file's project root) that start a program. */
  entryFiles?: readonly PathRule[];
  /** Same, only when the framework id is detected. */
  frameworkEntries?: Readonly<Record<string, readonly PathRule[]>>;
  /** Class/function attributes (as extracted, arguments included) a framework discovers. */
  entryDecorators?: RegExp;
  /** Base types / interfaces whose implementations a framework discovers. */
  entryBaseTypes?: RegExp;
  /** A file declaring routes is a controller the framework discovers. */
  routesAreEntries?: boolean;
  /** Source patterns that make a file an entry (`@main`, `__FILE__ == $0`). */
  entrySource?: readonly PathRule[];
  /** Files a tool runs: alive, never reported, anchor nothing. */
  passiveFiles?: readonly PathRule[];
  /** Source patterns that make a file public API or tool-run (Swift `public`). */
  passiveSource?: readonly PathRule[];
  frameworkPassive?: Readonly<Record<string, readonly PathRule[]>>;
  /** Project-relative paths of configuration files whose identifiers name entry points. */
  configFiles?: RegExp;
  /** Interpreters of extension-less `#!` scripts whose identifiers keep code alive. */
  shebang?: RegExp;
  /** Files compiled together: a directory (Go package). */
  unit?: "directory";
  /**
   * Load-time extension: returns members that replace the kit's (a Go
   * module-path resolver, a Dart entry rule wrapping `base.entryReason`).
   */
  extend?(ctx: ReachabilityLoadContext, kit: Kit, base: ReachabilityModel): Promise<Partial<ReachabilityModel>>;
}

/** What `extend` gets to build on. */
export interface Kit {
  /** Analyzed files of this language. */
  files: readonly string[];
  /** Project roots, innermost first. */
  roots: readonly string[];
  rootOf(file: string): string;
  readText(projectRelative: string): Promise<string | null>;
  /** Every regular file of the project (bounded, symlink-free), for config discovery. */
  listFiles(): Promise<string[]>;
}

export function conventionReachability(spec: ConventionSpec): ReachabilityHooks {
  return { load: (ctx) => loadConventionModel(ctx, spec) };
}

async function loadConventionModel(ctx: ReachabilityLoadContext, spec: ConventionSpec): Promise<ReachabilityModel> {
  const exts = spec.extensions;
  const fold = (s: string): string => (spec.caseInsensitive ? s.toLowerCase() : s);
  const isOurs = (f: string): boolean => exts.some((e) => f.toLowerCase().endsWith(e));
  const files = [...ctx.files].filter(isOurs).sort();
  const roots = [...new Set(["", ...ctx.roots])].sort((a, b) => b.length - a.length);
  const rootOf = (file: string): string => roots.find((r) => r === "" || file.startsWith(r + "/")) ?? "";

  // Path and suffix indexes, with and without the extension.
  const exact = new Map<string, string>();
  const bySuffix = new Map<string, string[]>();
  for (const f of files) {
    exact.set(fold(f), f);
    const noExt = f.replace(/\.[^./]+$/, "");
    for (const variant of new Set([f, noExt])) {
      const segs = variant.split("/");
      for (let i = 0; i < segs.length; i++) push(bySuffix, fold(segs.slice(i).join("/")), f);
    }
  }
  const probe = (base: string): string | null => {
    const b = fold(normalize(base));
    const hit = exact.get(b);
    if (hit) return hit;
    for (const e of exts) {
      const h = exact.get(b + e);
      if (h) return h;
    }
    for (const idx of spec.indexFiles ?? []) {
      const h = exact.get(fold(`${b}/${idx}`));
      if (h) return h;
    }
    return null;
  };
  const indexSuffixes = (spec.indexFiles ?? []).map((i) => i.replace(/\.[^.]+$/, ""));

  const resolve = (fromFile: string, source: string): string[] => {
    const path = spec.importPath?.(source);
    if (!path) return [];
    const dir = dirOf(fromFile);
    // Beside the importer first (`#include "x.h"`, `require_relative`).
    const local = probe(dir ? `${dir}/${path}` : path);
    if (local) return [local];
    if (path.startsWith(".")) return [];
    // Then anywhere the path ends that way: source roots are rarely declared.
    const key = fold(normalize(path));
    const hits = bySuffix.get(key) ?? bySuffix.get(key.replace(/\.[^./]+$/, ""));
    if (hits) return [...hits];
    for (const idx of indexSuffixes) {
      const h = bySuffix.get(fold(`${key}/${idx}`));
      if (h) return [...h];
    }
    return [];
  };

  // Configuration and scripts the framework reads by name.
  const configMentions = new Set<string>();
  if (spec.configFiles) {
    for (const rel of await listProjectFiles(ctx)) {
      if (!spec.configFiles.test(rel)) continue;
      const text = await readCapped(join(ctx.projectRoot, rel));
      if (text) for (const t of text.match(IDENTIFIER_RE) ?? []) configMentions.add(t);
    }
  }
  if (spec.shebang) {
    const dirs = [...files.map(dirOf), ...roots.flatMap((r) => [r, ...SCRIPT_DIRS.map((d) => (r ? `${r}/${d}` : d))])];
    for (const script of await findShebangScripts(ctx.projectRoot, dirs, spec.shebang)) {
      for (const t of script.text.match(IDENTIFIER_RE) ?? []) configMentions.add(t);
    }
  }

  const names = spec.names;
  const model: ReachabilityModel = {
    manifestEntries: [],
    judgeExports: false,
    resolve,
    resolvePath: () => [],

    // Where a program STARTS — these anchor a project.
    entryReason(analysis, relPath, frameworks, readSource) {
      for (const [re, reason] of spec.entryFiles ?? []) if (re.test(relPath)) return reason;
      for (const fw of frameworks) {
        for (const [re, reason] of spec.frameworkEntries?.[fw] ?? []) if (re.test(relPath)) return reason;
      }
      if (spec.mainFunctions) {
        const methods = analysis.classes.flatMap((c) => c.methods);
        const main = [...analysis.functions, ...methods].find((f) => spec.mainFunctions!.test(leaf(f.name)));
        if (main) return `program entry (${leaf(main.name)})`;
      }
      if (spec.entrySource && readSource) {
        const src = readSource();
        if (src) for (const [re, reason] of spec.entrySource) if (re.test(src)) return reason;
      }
      return null;
    },

    // What a framework or tool INSTANTIATES — alive and never reported, but
    // no evidence of where a program starts: a class library full of
    // [ApiController]s or @Components is still only a library.
    passiveReason(analysis, relPath, frameworks, readSource) {
      for (const [re, reason] of spec.passiveFiles ?? []) if (re.test(relPath)) return reason;
      for (const fw of frameworks) {
        for (const [re, reason] of spec.frameworkPassive?.[fw] ?? []) if (re.test(relPath)) return reason;
      }
      if (spec.routesAreEntries && analysis.routes.length > 0) return "declares routes (discovered by the framework)";
      const methods = analysis.classes.flatMap((c) => c.methods);
      if (spec.entryDecorators) {
        for (const owner of [...analysis.classes, ...analysis.functions, ...methods]) {
          const dec = (owner.decorators ?? []).find((d) => spec.entryDecorators!.test(d));
          if (dec) return `framework-managed (@${dec.replace(/\(.*$/s, "")})`;
        }
      }
      if (spec.entryBaseTypes) {
        for (const c of analysis.classes) {
          const base = [c.extends, ...(c.implements ?? [])]
            .filter((t): t is string => !!t)
            .map(typeLeaf)
            .find((t) => spec.entryBaseTypes!.test(t));
          if (base) return `framework base type (${base})`;
        }
      }
      if (spec.passiveSource && readSource) {
        const src = readSource();
        if (src) for (const [re, reason] of spec.passiveSource) if (re.test(src)) return reason;
      }
      // Nothing to mention by name — assembly attributes, global usings, a
      // DSL block, a data table, top-level code: never judged.
      if (names?.types && analysis.classes.length === 0 && !analysis.functions.some((f) => f.name !== "<setup>")) {
        const src = names.declaration ? readSource?.() : undefined;
        if (!src || ![...src.matchAll(names.declaration!)].length) return "declares no type or function to reference";
      }
      return null;
    },
  };

  if (names) {
    model.declaredNames = (analysis: FileAnalysis, source: string | undefined): string[] => {
      const out: string[] = [];
      if (names.types) for (const c of analysis.classes) out.push(typeLeaf(c.name));
      if (names.functions) {
        for (const f of analysis.functions) if (f.name !== "<setup>") out.push(leaf(f.name));
      }
      if (names.methodsOf) {
        for (const c of analysis.classes) if (names.methodsOf.test(typeLeaf(c.name))) for (const m of c.methods) out.push(leaf(m.name));
      }
      if (names.stem) out.push(stemOf(analysis.filePath));
      if (names.declaration && source) for (const m of source.matchAll(names.declaration)) out.push(typeLeaf(m[1]!));
      return out.filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
    };
  }
  if (configMentions.size > 0) model.configMentions = configMentions;
  if (spec.unit === "directory") model.unitOf = (f) => (isOurs(f) ? dirOf(f) : null);

  if (spec.extend) {
    Object.assign(model, await spec.extend(ctx, {
      files,
      roots,
      rootOf,
      readText: (rel) => readCapped(join(ctx.projectRoot, rel)),
      listFiles: () => listProjectFiles(ctx),
    }, { ...model }));
  }
  return model;
}

/**
 * `base.passiveReason`, then `extra` — how an `extend` adds a load-time rule
 * (a library root's public files) without losing the spec's own.
 */
export function withPassive(
  base: ReachabilityModel,
  extra: (analysis: FileAnalysis, relPath: string) => string | null,
): Pick<ReachabilityModel, "passiveReason"> {
  return {
    passiveReason: (analysis, relPath, frameworks, readSource) =>
      base.passiveReason?.(analysis, relPath, frameworks, readSource) ?? extra(analysis, relPath),
  };
}

/** Identifier tokens, as core scans source text. */
export const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** `A.B.C`, `A::B`, `A\B` → `C`; generics and array suffixes dropped. */
export function typeLeaf(name: string): string {
  const plain = name.replace(/<.*$/s, "").replace(/\[.*$/s, "").replace(/\(.*$/s, "").trim();
  return leaf(plain);
}

function leaf(name: string): string {
  const parts = name.split(/::|[.\\#/]/).filter(Boolean);
  return (parts[parts.length - 1] ?? name).replace(/[^A-Za-z0-9_]/g, "");
}

function stemOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  return base.replace(/\..*$/, "");
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

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}

const MAX_CONFIG_BYTES = 1024 * 1024;

async function readCapped(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > MAX_CONFIG_BYTES) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** Directories that hold build output, dependencies or tooling state, never configuration we want. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "bin", "obj", "target", "build", "dist", "out", "vendor", ".gradle", ".idea",
  ".vs", ".vscode", "Pods", "DerivedData", "__pycache__", ".venv", "venv", ".next", ".nuxt", "coverage",
  ".clarifydoc", "_build", "deps", ".dart_tool", ".stack-work", "dist-newstyle",
]);
const MAX_DEPTH = 10;
const MAX_LISTED = 100_000;

/**
 * Every regular file under the project (posix, project-relative), bounded and
 * symlink-free, listed once per analysis and shared by every model of it.
 */
const listings = new WeakMap<ReachabilityLoadContext, Promise<string[]>>();
function listProjectFiles(ctx: ReachabilityLoadContext): Promise<string[]> {
  let p = listings.get(ctx);
  if (!p) {
    p = (async () => {
      const out: string[] = [];
      const walk = async (rel: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || out.length >= MAX_LISTED) return;
        let entries: import("fs").Dirent[];
        try {
          entries = await readdir(join(ctx.projectRoot, rel), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const child = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) await walk(child, depth + 1);
          } else if (e.isFile()) out.push(child);
        }
      };
      await walk("", 0);
      return out.sort();
    })();
    listings.set(ctx, p);
  }
  return p;
}
