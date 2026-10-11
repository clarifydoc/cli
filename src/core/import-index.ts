import type { FileAnalysis } from "../types/analysis.js";
import type { ImportIndex } from "../types/project.js";
import { extensionFamily, relativeModulePath } from "../extractors/plugins/shared/path-utils.js";
import { EXTENSION_TO_LANGUAGE, PARTIAL_PREFIX_BY_LANGUAGE, extensionsOfFamily } from "../extractors/registry.js";

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
export type { ImportIndex } from "../types/project.js";

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
 * Resolve macro-valued dataSource targets/entities through extracted string
 * constants. C/C++ DAOs name their tables via preprocessor constants
 * (`#define CUE_TABLE "cues"` in the header, used as `"DELETE FROM "
 * CUE_TABLE` in the .cpp); Delphi forms declare a component's table
 * (`FDTable1: TFDTable` + `TableName = 'squad'`) that the companion unit
 * opens by component name.
 *
 * Resolution is TIERED, most-local first, and each tier nullifies a name
 * defined with conflicting values (safety over coverage):
 *   1. companion scope — constants from files sharing the path-minus-extension
 *      (fMain.fmx ↔ fMain.pas). IDE-default component names (`FDTable1`)
 *      repeat across projects with different tables; the project-wide union
 *      nullifies them, but each pair is unambiguous locally.
 *   2. project-wide union — cross-file macros (header → .cpp).
 * Each tier is consulted exact-case first, then case-folded (Pascal is a
 * case-insensitive language; `qrySales` in the form, `QrySales` in code).
 * Mutates analyses.
 */
export function resolveDataSourceStringConstants(analyses: FileAnalysis[]): void {
  type Tier = Map<string, string | null>; // null = conflicting → skip
  const global: Tier = new Map();
  const globalCi: Tier = new Map();
  const localByBase = new Map<string, { exact: Tier; ci: Tier }>();

  const put = (m: Tier, k: string, v: string) => {
    const prev = m.get(k);
    if (prev === undefined) m.set(k, v);
    else if (prev !== v) m.set(k, null);
  };
  const baseOf = (p: string) =>
    p.replace(/\\/g, "/").replace(/\.[^./]+$/, "").toLowerCase();

  for (const a of analyses) {
    const entries = Object.entries(a.stringConstants ?? {});
    if (entries.length === 0) continue;
    const base = baseOf(a.filePath);
    let local = localByBase.get(base);
    if (!local) {
      local = { exact: new Map(), ci: new Map() };
      localByBase.set(base, local);
    }
    for (const [name, value] of entries) {
      put(global, name, value);
      put(globalCi, name.toLowerCase(), value);
      put(local.exact, name, value);
      put(local.ci, name.toLowerCase(), value);
    }
  }
  if (global.size === 0) return;

  for (const a of analyses) {
    const local = localByBase.get(baseOf(a.filePath));
    const resolve = (name: string): string | null => {
      const lower = name.toLowerCase();
      return (
        local?.exact.get(name) ?? local?.ci.get(lower) ??
        global.get(name) ?? globalCi.get(lower) ?? null
      );
    };
    for (const ds of a.dataSources ?? []) {
      if (ds.kind !== "database") continue;
      const targetValue = ds.target ? resolve(ds.target) : null;
      if (ds.entity) {
        const v = resolve(ds.entity);
        if (v) ds.entity = v;
      } else if (targetValue) {
        // A datastore NAMED by a resolvable constant IS that table — backfill
        // the entity so symbol attribution reaches the physical entity (how
        // Delphi `qrySales.Open` in code joins the SQL declared on the form).
        ds.entity = targetValue;
      }
      if (targetValue) ds.target = targetValue;
    }
  }
}

/**
 * Same logic as `enrichDataSourcesWithImports` but for a single file —
 * runnable inline during per-file extraction so the on-disk per-file JSON
 * reflects the enriched `target`. The lookup only needs the file's own
 * imports, so we can build a tiny one-file index without project context.
 */
export function enrichFileDataSources(
  a: FileAnalysis,
  index?: ImportIndex,
  /**
   * Variable-to-module bindings from the language plugin
   * (`const prisma = new PrismaClient()` → prisma → "@prisma/client"). An
   * import alone cannot name the receiver a call is made on, so without these
   * the commonest ORM idiom resolved to no datastore at all and every such
   * call collected under the graph's "(unresolved)" node.
   */
  variableAliases?: ReadonlyMap<string, { source: string } | string>,
): void {
  const idx = index ?? buildImportIndex([a]);
  const aliasSource = (name: string): string | undefined => {
    const hit = variableAliases?.get(name);
    return typeof hit === "string" ? hit : hit?.source;
  };
  for (const ds of a.dataSources ?? []) {
    if (ds.target) continue;
    // An api-call's target is an endpoint URL — and a queue op's target is a
    // broker destination (exchange/queue/topic) — never an import module; leave
    // them null rather than backfilling the caller's import source (which
    // produced bogus targets like "../store", "axios", "zod").
    if (ds.kind === "api-call" || ds.kind === "queue-publish" || ds.kind === "queue-consume") continue;
    const root = rootIdentifier(ds.name);

    // 1) Direct name match — strongest signal.
    if (root) {
      const src = idx.sourceFor(a.filePath, root);
      if (src) {
        ds.target = src;
        continue;
      }
      // 1b) The receiver is a local bound to an imported constructor/factory.
      const viaAlias = aliasSource(root);
      if (viaAlias) {
        ds.target = viaAlias;
        ds.targetConfidence = "INFERRED";
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

  // Resolve the specific entity/table each DB call touches, derived from the
  // call chain (`prisma.user.findMany` → "user"). Runs independently of target
  // resolution so it also fires when `target` was already set. SQL DML names are
  // single-segment verbs (SELECT/INSERT/…) — `entitySegment` returns null for
  // those, leaving the SQL flow (table already in `target`) untouched.
  const delphi = a.language === "pascal" || a.language === "dfm";
  for (const ds of a.dataSources ?? []) {
    if (ds.kind !== "database" || ds.entity) continue;
    // Delphi: `Query.FieldByName` / `dsPlayers.Open` is `component.method`, NOT
    // the `Model.findOne` shape `entitySegment` is reading it as. The receiver
    // is a dataset variable or form component, so naming it as the entity both
    // invents tables (`DataSet`, `ADataSet`, `Qry` — half of one real Delphi app's DB accesses)
    // and BLOCKS the real link: `resolveDataSourceStringConstants` backfills the
    // physical table from the form's component→table map only while `entity` is
    // still empty. Leave it empty and let that pass do its job.
    if (delphi && isDatasetApiCall(ds.name)) continue;
    // Prefer the call-chain segment; fall back to a generic type argument, which
    // is where EF Core / typed-ORM calls carry the entity (`_context.Set<User>()`,
    // `DbSet<Order>`, `repository.Query<Account>()`).
    const entity = entitySegment(ds.name) ?? entityFromGeneric(ds.target) ?? entityFromGeneric(ds.name);
    if (entity) ds.entity = entity;
  }
}

/**
 * Methods of Delphi's `TDataSet` / `TCustomConnection` API. A call whose leaf is
 * one of these operates ON a dataset or connection object, so its receiver is a
 * component instance (`dsPlayerInfo`, `Query`, `ADataSet`) — never a table name.
 * No ORM names a model method `FieldByName` or `ExecSQL`, so this stays a purely
 * Delphi-shaped signal even though it is matched by name.
 */
const DATASET_API_METHODS = new Set([
  "open", "close", "execsql", "execproc", "execute", "executedirect",
  "post", "append", "insert", "edit", "delete", "cancel", "refresh",
  "first", "last", "next", "prior", "locate", "lookup", "fieldbyname",
  "findfield", "parambyname", "applyupdates", "cancelupdates", "commitupdates",
  "starttransaction", "commit", "rollback", "commitretaining", "rollbackretaining",
  "disablecontrols", "enablecontrols", "fullrefresh", "checkbrowsemode", "prepare",
]);

/** `Receiver.Method` where Method is a TDataSet/connection API call. */
function isDatasetApiCall(callName: string): boolean {
  const chain = callName.split(/[([<]/)[0]!;
  const parts = chain.split(".").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return DATASET_API_METHODS.has(parts[parts.length - 1]!.toLowerCase());
}

/** First generic type argument in a call/receiver string, e.g. `Set<AccountOwner>()`. */
const GENERIC_ARG_RE = /<\s*([A-Za-z_][\w.]*)\s*>/;

/**
 * Extract the entity from a generic type argument, e.g. `Set<AccountOwner>()` →
 * "AccountOwner", `DbSet<Order>` → "Order". Takes the first `<…>` argument,
 * keeps its last dotted segment, and accepts it only when it reads like a type
 * name (capitalised identifier) — so `Task<bool>` / `List<string>` are ignored.
 */
function entityFromGeneric(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(GENERIC_ARG_RE);
  if (!m) return null;
  const last = m[1]!.split(".").pop()!;
  return /^[A-Z]/.test(last) && isIdentifier(last) ? last : null;
}

/**
 * Technical receiver roots that are never the entity itself — ORM clients,
 * connections, DI-injected contexts/repositories, query builders, etc.
 */
const NON_ENTITY_ROOTS = new Set([
  "prisma", "db", "client", "knex", "ctx", "context", "dbcontext", "_context",
  "_db", "session", "em", "entitymanager", "repo", "repository", "conn",
  "connection", "pool", "cursor", "engine", "datasource", "ds", "orm",
  "sequelize", "mongoose", "models", "qb", "querybuilder", "this", "self",
  "manager", "store",
]);

/**
 * Derive the entity/model/table segment from a DB call chain.
 *   `prisma.user.findMany`   → "user"   (segment before the ORM method)
 *   `_context.Users.Find`    → "Users"
 *   `User.findOne`           → "User"   (root is the entity when capitalised)
 *   `repository.save`        → null     (root is a technical receiver)
 *   `SELECT` / `EXEC`        → null     (single-segment SQL verb)
 */
function entitySegment(callName: string): string | null {
  if (!callName) return null;
  const chain = callName.split(/[([<]/)[0]!; // drop args/generics
  const parts = chain.split(".").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const cand = parts[parts.length - 2]!; // segment before the method leaf
    return isEntityCandidate(cand) ? cand : null;
  }
  if (parts.length === 2) {
    const root = parts[0]!;
    // `User.findOne` — the root is the model when it isn't a technical receiver
    // and reads like a type name (Capitalised).
    if (!NON_ENTITY_ROOTS.has(root.toLowerCase()) && /^[A-Z]/.test(root) && isEntityCandidate(root)) {
      return root;
    }
  }
  return null;
}

/** A plain identifier that is not a known database-client root (`prisma`, `db`, `repo`, `session`, …). */
function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s) && !NON_ENTITY_ROOTS.has(s.toLowerCase());
}

/**
 * A chain segment that can plausibly BE an entity/model. SCREAMING_SNAKE
 * segments are constants (`RE_CPP_CLASSNAME.findall`), and `_`/`__`-prefixed
 * segments are private internals (`this.__data__.get`) — neither is a model.
 */
function isEntityCandidate(s: string): boolean {
  if (!isIdentifier(s)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(s) && s.includes("_")) return false;
  if (s.startsWith("_")) return false;
  return true;
}

/** Whether an opened namespace belongs to a database/ORM package. */
function matchesDbNamespace(ns: string): boolean {
  const lower = ns.toLowerCase();
  return DB_NAMESPACE_MARKERS.some((m) => lower.includes(m));
}

/** The leading identifier of a call chain (`prisma` from `prisma.user.findMany(`), or null. */
function rootIdentifier(callName: string): string | null {
  if (!callName) return null;
  // Strip generic args, parens, etc. Use everything up to the first '.' or '('.
  const stop = callName.search(/[.([<]/);
  const head = stop >= 0 ? callName.slice(0, stop) : callName;
  return /^[A-Za-z_$][\w$]*$/.test(head) ? head : null;
}

/**
 * Index every file's imports so later passes can answer "what does this local
 * name refer to" without re-reading the import lists.
 *
 * For each file it records the bound local names → module source, the module
 * sources that resolve to project files, and the namespaces opened by
 * wildcard/side-effect imports (which classify database calls through
 * `DB_NAMESPACE_MARKERS`).
 *
 * @param analyses - Every file analysis
 * @returns The index, keyed by file path
 */
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
      // Resolved per specifier, not once per import: `from app.api.routes
      // import authentication, comments` names two different FILES in one
      // statement, so a single resolution would map both to whichever one won.
      for (const spec of imp.specifiers) {
        if (lm.has(spec)) continue;
        const resolved = resolveImportSource(a.filePath, imp.source, knownFiles, spec);
        if (resolved) lm.set(spec, resolved);
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

/** Extension and index-file spellings tried, in order, for an extension-less specifier. */
const PROJECT_PATH_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte", "/index.ts", "/index.tsx", "/index.js", "/index.vue"];

/**
 * Resolve a relative/absolute module specifier (as written in source) to a
 * concrete project file path, trying the common JS/TS/Vue extension and
 * index-file conventions. Returns null for bare package specifiers or when no
 * known file matches. Exported so consumers outside the import index (e.g. the
 * screen builder following a route's lazy component) can reuse it.
 */
export function resolveImportSource(
  importingFile: string,
  src: string,
  knownFiles: Set<string>,
  /**
   * The bound name, when the caller has one. Python needs it: `from pkg.mod
   * import thing` names the module in `src` and the *file* in the specifier, so
   * `pkg/mod/thing.py` cannot be reached from `src` alone.
   */
  specifier?: string,
): string | null {
  if (!src) return null;
  const norm = importingFile.replace(/\\/g, "/");
  const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";

  if (!src.startsWith(".") && !src.startsWith("/")) {
    if (norm.endsWith(".py")) return resolvePythonModule(norm, dir, src, knownFiles, specifier);
    // A tsconfig alias (`@/foo`, a `baseUrl` path) is rewritten to a
    // project-relative path before this runs; it names a project file only if
    // one is there — a package import (`lodash/fp`) never matches.
    if (!src.includes("/")) return null;
    for (const ext of PROJECT_PATH_EXTENSIONS) {
      if (knownFiles.has(src + ext)) return src + ext;
    }
    return null;
  }

  const joined = normalizeJoin(dir, relativeModulePath(src));
  // `from . import graph` / `from .pkg import mod` name the module in the
  // specifier — tried before the package itself, as for absolute imports.
  if (norm.endsWith(".py") && specifier) {
    for (const ext of [`/${specifier}.py`, `/${specifier}/__init__.py`]) {
      if (knownFiles.has(joined + ext)) return joined + ext;
    }
  }
  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".vue",
                "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.vue",
                // Python relative imports: `from .articles import api`.
                ".py", "/__init__.py"];
  for (const ext of exts) {
    const candidate = joined + ext;
    if (knownFiles.has(candidate)) return candidate;
  }
  // Any other extension of the importer's own family: CoffeeScript's
  // `require './routes/orders'` names `orders.coffee`. A family whose
  // partials carry a prefix (Sass `_buttons.scss`) is tried with it too.
  const partial = PARTIAL_PREFIX_BY_LANGUAGE.get(EXTENSION_TO_LANGUAGE[norm.slice(norm.lastIndexOf(".")).toLowerCase()] ?? "");
  const slash = joined.lastIndexOf("/");
  for (const ext of extensionsOfFamily(extensionFamily(norm))) {
    const candidates = [joined + ext, `${joined}/index${ext}`];
    if (partial) candidates.push(`${joined.slice(0, slash + 1)}${partial}${joined.slice(slash + 1)}${ext}`, `${joined}/${partial}index${ext}`);
    for (const candidate of candidates) {
      if (knownFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve a dotted Python module (`app.api.routes`) to a file in the project.
 *
 * Two things make this harder than the relative case. The module path is
 * absolute from a source root the analysis never learns (it may be the project
 * root, or `src/`, or a package directory), so every ancestor of the importing
 * file is tried as a candidate root, nearest first. And `from pkg import mod`
 * puts the module the caller means in the *specifier*, not the source — so
 * `pkg/<specifier>.py` is tried before `pkg.py` itself.
 *
 * Bounded work: (depth of the importing file) × 4 set lookups, no scan of the
 * project. A bare third-party import (`from fastapi import APIRouter`) simply
 * misses every candidate and returns null, which is the correct answer.
 */
function resolvePythonModule(
  importingFile: string,
  dir: string,
  src: string,
  knownFiles: Set<string>,
  specifier: string | undefined,
): string | null {
  if (!/^[A-Za-z_][\w.]*$/.test(src)) return null;
  const modulePath = src.replace(/\./g, "/");

  // Ancestors of the importing file, nearest first, then the project root.
  const roots: string[] = [];
  for (let d = dir; d !== ""; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    roots.push(d);
  }
  roots.push("");

  for (const root of roots) {
    const base = root ? `${root}/${modulePath}` : modulePath;
    const candidates = specifier
      ? [`${base}/${specifier}.py`, `${base}/${specifier}/__init__.py`, `${base}.py`, `${base}/__init__.py`]
      : [`${base}.py`, `${base}/__init__.py`];
    for (const candidate of candidates) {
      if (knownFiles.has(candidate) && candidate !== importingFile) return candidate;
    }
  }
  return null;
}

/** Join a directory and a relative path, resolving `.` and `..` segments, posix-style. */
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
