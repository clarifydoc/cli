import type { FileAnalysis } from "../types/analysis.js";

/**
 * Project-wide import index, built once after per-file extraction. Works
 * across every language because it consumes only `FileAnalysis.imports`,
 * which every extractor populates.
 *
 * Three complementary lookups:
 *   - localFor(file, name): if `name` was imported from a relative source
 *     that resolves to another file in the project, returns that file path.
 *     Used to disambiguate cross-file type/symbol references.
 *   - sourceFor(file, name): returns the raw import source string for `name`
 *     in `file` (bare package, relative path, or absolute alias). Used to
 *     confirm "this `prisma` actually came from `@prisma/client`" without
 *     needing to resolve the package itself. Also covers namespace alias
 *     imports (`import * as ns from 'pkg'` → name=ns) and Kotlin/Java
 *     `import com.foo.Bar` (name=Bar).
 *   - namespacesFor(file): list of namespace/wildcard import sources brought
 *     into scope without a binding name. Covers C# `using System.Linq`,
 *     Java/Kotlin `import com.foo.*`, Python `from pkg import *`. Useful as
 *     a secondary signal when a call's root identifier can't be resolved by
 *     name (e.g. EF Core's DI-injected `dbContext`).
 */
export interface ImportIndex {
  localFor(file: string, name: string): string | null;
  sourceFor(file: string, name: string): string | null;
  namespacesFor(file: string): string[];
}

/**
 * Substring markers that flag a namespace import as data-access related.
 * Used to attribute database calls whose root identifier isn't a named
 * import (DI-injected repositories, EF DbContexts, Hibernate sessions, …).
 * Case-insensitive.
 */
const DB_NAMESPACE_MARKERS = [
  "entityframework", "prisma", "sequelize", "typeorm", "mongoose",
  "knex", "hibernate", "persistence", "jpa", "sqlalchemy",
  "mongo", "redis", "dapper", "repository", "dataaccess", "database",
];

/**
 * Walk every FileAnalysis and fill in `dataSources[].target` for entries
 * whose root identifier traces back through the file's imports. Works for
 * any language because it only reads `imports` + `dataSources`, both of
 * which every extractor populates. Non-destructive: only sets `target`
 * when it was previously null.
 *
 * Resolution order for a given data source:
 *   1. Named-import match — root identifier was imported by name.
 *      Example: `prisma.user.findMany` + `import { prisma } from '@/lib/prisma'`
 *      → target = `'@/lib/prisma'`.
 *   2. Namespace-import fallback (database kind only) — root identifier
 *      isn't named in imports, but the file pulls in a namespace whose
 *      source matches a DB marker (EF, Hibernate, …).
 *      Example: `_db.Users.Find(id)` + `using Microsoft.EntityFrameworkCore`
 *      → target = `'Microsoft.EntityFrameworkCore'`.
 */
export function enrichDataSourcesWithImports(analyses: FileAnalysis[], index: ImportIndex): void {
  for (const a of analyses) enrichFileDataSources(a, index);
}

/**
 * Same logic as `enrichDataSourcesWithImports` but for a single file —
 * runnable inline during per-file extraction so the on-disk per-file JSON
 * reflects the enriched `target`. The lookup only needs the file's own
 * imports, so we can build a tiny one-file index without project context.
 */
export function enrichFileDataSources(a: FileAnalysis, index?: ImportIndex): void {
  const idx = index ?? buildImportIndex([a]);
  for (const ds of a.dataSources ?? []) {
    if (ds.target) continue;
    // An api-call's target is an endpoint URL, never an import module — leave it
    // null rather than backfilling the caller's import source (which produced
    // bogus targets like "../store", "axios", "zod").
    if (ds.kind === "api-call") continue;
    const root = rootIdentifier(ds.name);

    // 1) Direct name match — strongest signal.
    if (root) {
      const src = idx.sourceFor(a.filePath, root);
      if (src) {
        ds.target = src;
        continue;
      }
    }

    // 2) Namespace fallback for DB-shaped calls only.
    if (ds.kind === "database") {
      const namespaces = idx.namespacesFor(a.filePath);
      const match = namespaces.find(matchesDbNamespace);
      if (match) ds.target = match;
    }
  }
}

function matchesDbNamespace(ns: string): boolean {
  const lower = ns.toLowerCase();
  return DB_NAMESPACE_MARKERS.some((m) => lower.includes(m));
}

function rootIdentifier(callName: string): string | null {
  if (!callName) return null;
  // Strip generic args, parens, etc. Use everything up to the first '.' or '('.
  const stop = callName.search(/[.([<]/);
  const head = stop >= 0 ? callName.slice(0, stop) : callName;
  return /^[A-Za-z_$][\w$]*$/.test(head) ? head : null;
}

export function buildImportIndex(analyses: FileAnalysis[]): ImportIndex {
  const knownFiles = new Set<string>(analyses.map((a) => a.filePath));
  const local = new Map<string, Map<string, string>>();
  const source = new Map<string, Map<string, string>>();
  const namespaces = new Map<string, string[]>();

  for (const a of analyses) {
    const lm = new Map<string, string>();
    const sm = new Map<string, string>();
    const ns: string[] = [];
    for (const imp of a.imports ?? []) {
      // Imports with no name bindings = namespace/wildcard/side-effect.
      // C# `using System.Linq`, Java/Kotlin `import com.foo.*`, Python
      // `from pkg import *`, JS side-effect `import 'reflect-metadata'`.
      if ((imp.specifiers ?? []).length === 0) {
        if (imp.source) ns.push(imp.source);
        continue;
      }
      for (const spec of imp.specifiers) {
        if (!sm.has(spec)) sm.set(spec, imp.source);
      }
      const resolved = resolveImportSource(a.filePath, imp.source, knownFiles);
      if (resolved) {
        for (const spec of imp.specifiers) {
          if (!lm.has(spec)) lm.set(spec, resolved);
        }
      }
    }
    local.set(a.filePath, lm);
    source.set(a.filePath, sm);
    namespaces.set(a.filePath, ns);
  }

  return {
    localFor: (file, name) => local.get(file)?.get(name) ?? null,
    sourceFor: (file, name) => source.get(file)?.get(name) ?? null,
    namespacesFor: (file) => namespaces.get(file) ?? [],
  };
}

/**
 * Resolve a relative/absolute module specifier (as written in source) to a
 * concrete project file path, trying the common JS/TS/Vue extension and
 * index-file conventions. Returns null for bare package specifiers or when no
 * known file matches. Exported so consumers outside the import index (e.g. the
 * screen builder following a route's lazy component) can reuse it.
 */
export function resolveImportSource(importingFile: string, src: string, knownFiles: Set<string>): string | null {
  if (!src || (!src.startsWith(".") && !src.startsWith("/"))) return null;
  const norm = importingFile.replace(/\\/g, "/");
  const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
  const joined = normalizeJoin(dir, src);
  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".vue",
                "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.vue"];
  for (const ext of exts) {
    const candidate = joined + ext;
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function normalizeJoin(dir: string, rel: string): string {
  const parts = `${dir}/${rel}`.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
