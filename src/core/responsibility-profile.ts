import type {
  BoundaryEvidence,
  BoundaryKind,
  FileAnalysis,
  PackageCategory,
  ResponsibilityProfile,
  WorkflowRole,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { classifyKnownPackage, type KnownPackageEntry } from "../extractors/registry.js";
import { spansOf, innermostAt } from "./api-route-symbol-links.js";

/**
 * Per-file responsibility profile: which external boundaries a file touches
 * (database, HTTP, queue, auth, logging, …) and which workflow roles that
 * implies (persistence, transport, messaging, security, …).
 *
 * The god-object pattern counts functions; this counts CONCERNS. A file that
 * reads the database, publishes to a queue, calls an HTTP API and checks a
 * token mixes four responsibilities however few functions it has — that mix,
 * not the size, is what makes it hard to change safely.
 *
 * Evidence comes from two places the pipeline already extracts:
 *  - imports, classified through the plugin-contributed `knownPackages`
 *    tables (the same ones the dependency inventory uses), so the core holds
 *    no package names of its own;
 *  - `dataSources` / `routes` / `screens`, which carry the operation
 *    (read/write/publish/consume/serve) the import alone cannot.
 *
 * Deterministic and language-agnostic; files with no boundary evidence are
 * omitted from the result.
 */

/** Evidence rows kept per file (sorted by line); counts stay exact. */
const EVIDENCE_CAP = 25;

/** Package category → boundary. Categories absent here (build, lint, testing, util, …) are not boundaries. */
const CATEGORY_BOUNDARY: Partial<Record<PackageCategory, BoundaryKind>> = {
  orm: "database",
  database: "database",
  http: "http",
  graphql: "graphql",
  grpc: "grpc",
  messaging: "queue",
  auth: "auth",
  logging: "logging",
  cloud: "cloud",
  serialization: "serialization",
  validation: "validation",
  state: "state",
  ui: "ui",
  frontend: "ui",
};

/** Boundary → the workflow role it evidences. */
export const BOUNDARY_ROLE: Record<BoundaryKind, WorkflowRole> = {
  database: "persistence",
  http: "transport",
  graphql: "transport",
  grpc: "transport",
  queue: "messaging",
  auth: "security",
  logging: "observability",
  cloud: "integration",
  serialization: "mapping",
  validation: "validation",
  ui: "presentation",
  state: "presentation",
  config: "configuration",
};

/**
 * Roles that nearly every file legitimately carries — a logger import or an
 * environment read is not a mixed concern. Excluded from `concernCount`.
 */
const UBIQUITOUS_ROLES: ReadonlySet<WorkflowRole> = new Set<WorkflowRole>(["observability", "configuration"]);

const RELATIVE_IMPORT_RE = /^(\.|\/|~|@\/)/;

/**
 * Classify an import source through the plugin package tables, trying the
 * name shapes an import can take: the full source, the npm `@scope/pkg` or
 * bare-root form, every dotted / `::` / `\` namespace prefix from longest to
 * shortest (`Microsoft.EntityFrameworkCore.Metadata` → `Microsoft.EntityFrameworkCore`),
 * and finally the trailing path segment (`gorm.io/gorm` → `gorm`). Returns the
 * first hit; relative and alias imports are never classified.
 */
export function classifyImportSource(source: string): KnownPackageEntry | undefined {
  const s = source.trim();
  if (!s || RELATIVE_IMPORT_RE.test(s)) return undefined;
  const lower = s.toLowerCase();

  const direct = classifyKnownPackage(lower);
  if (direct) return direct;

  if (lower.startsWith("@")) {
    const parts = lower.split("/");
    if (parts.length >= 2) {
      const scoped = classifyKnownPackage(`${parts[0]}/${parts[1]}`);
      if (scoped) return scoped;
    }
    return undefined;
  }

  // Namespace-style prefixes, longest first.
  const sep = lower.includes("::") ? "::" : lower.includes("\\") ? "\\" : lower.includes(".") ? "." : null;
  if (sep) {
    const parts = lower.split(sep);
    for (let n = parts.length - 1; n >= 1; n--) {
      const hit = classifyKnownPackage(parts.slice(0, n).join(sep));
      if (hit) return hit;
    }
  }

  // Path-style: root segment, then trailing segment (Go module tails, Maven artifactIds).
  if (lower.includes("/")) {
    const segs = lower.split("/");
    const head = classifyKnownPackage(segs[0]!);
    if (head) return head;
    const tail = segs[segs.length - 1]!;
    if (tail && tail !== lower) {
      const byTail = classifyKnownPackage(tail);
      if (byTail) return byTail;
    }
  }
  return undefined;
}

/** Non-relative import root used to count distinct external packages. */
function externalRoot(source: string): string | null {
  const s = source.trim().toLowerCase();
  if (!s || RELATIVE_IMPORT_RE.test(s)) return null;
  if (s.startsWith("@")) {
    const parts = s.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return s.split(/[/.:\\]/)[0] || null;
}

/** Functions kept in `topSymbols`. Counts stay exact. */
const TOP_SYMBOL_CAP = 5;

/**
 * Attribute each boundary-bearing piece of evidence to the function that
 * contains it, so the profile can say whether a file's concerns are
 * concentrated in one orchestrator or smeared across every function.
 *
 * Uses the evidence the profile already collects, which carries a line. It
 * deliberately does NOT use `symbolDataAccess`: that is gated on resolving an
 * entity, so a Spring Data module with fifty database calls and no resolvable
 * entity produces no rows at all there.
 */
function attributeToSymbols(
  a: FileAnalysis,
  evidence: readonly BoundaryEvidence[],
): Pick<ResponsibilityProfile, "symbolsWithBoundary" | "mixedSymbols" | "maxSymbolConcerns" | "topSymbols"> {
  const spans = spansOf(a);
  if (spans.length === 0) return {};

  const bySymbol = new Map<string, { line: number; boundaries: Set<BoundaryKind> }>();
  for (const row of evidence) {
    // Imports sit at the top of the file, outside every function: they say the
    // file can reach a boundary, not that any particular function does.
    if (row.source === "import" || row.line === undefined) continue;
    const span = innermostAt(spans, row.line);
    if (!span) continue; // module-level statement
    let entry = bySymbol.get(span.symbol);
    if (!entry) bySymbol.set(span.symbol, (entry = { line: span.line, boundaries: new Set() }));
    entry.boundaries.add(row.kind);
  }
  if (bySymbol.size === 0) return {};

  const rows = [...bySymbol].map(([symbol, v]) => {
    const boundaries = [...v.boundaries].sort();
    const concerns = new Set(boundaries.map((b) => BOUNDARY_ROLE[b])).size
      - boundaries.filter((b) => UBIQUITOUS_ROLES.has(BOUNDARY_ROLE[b])).length;
    return { symbol, line: v.line, boundaries, concerns: Math.max(0, concerns) };
  });

  rows.sort((x, y) => y.concerns - x.concerns || x.line - y.line || byOrdinal(x.symbol, y.symbol));
  return {
    symbolsWithBoundary: rows.length,
    mixedSymbols: rows.filter((r) => r.concerns >= 2).length,
    maxSymbolConcerns: rows[0]?.concerns ?? 0,
    topSymbols: rows.slice(0, TOP_SYMBOL_CAP).map(({ symbol, line, boundaries }) => ({ symbol, line, boundaries })),
  };
}

/** Build the responsibility profile for every file that touches at least one boundary. */
export function buildResponsibilityProfiles(analyses: readonly FileAnalysis[]): ResponsibilityProfile[] {
  const out: ResponsibilityProfile[] = [];

  for (const a of analyses) {
    const evidence: BoundaryEvidence[] = [];
    const externals = new Set<string>();
    let readsState = false;
    let touchesDatabase = false;
    let writesState = false;
    let emitsEvents = false;
    let consumesEvents = false;
    let servesRequests = false;
    let callsExternal = false;

    // Imports → boundaries (no operation: an import says WHAT, not HOW).
    const seenImportBoundary = new Set<string>();
    for (const imp of a.imports) {
      const root = externalRoot(imp.source);
      if (root) externals.add(root);
      const entry = classifyImportSource(imp.source);
      const kind = entry ? CATEGORY_BOUNDARY[entry.category] : undefined;
      if (!kind) continue;
      // One import row per (boundary, package root) keeps a file that imports
      // five submodules of one ORM from looking like five boundaries.
      const key = `${kind}|${root ?? imp.source}`;
      if (seenImportBoundary.has(key)) continue;
      seenImportBoundary.add(key);
      evidence.push({ kind, source: "import", name: imp.source, line: imp.line, operation: "use" });
      if (kind === "http" || kind === "graphql" || kind === "grpc" || kind === "cloud") callsExternal = true;
    }

    // Data sources → boundaries WITH operations.
    for (const ds of a.dataSources) {
      switch (ds.kind) {
        case "database": {
          const operation = ds.access ?? "use";
          // Unclassified is NOT a read. Treating it as one meant a C# file that
          // only ever wrote reported `readsState: true, writesState: false`,
          // and the honest answer ("we could not tell") was unavailable to
          // anyone. The boundary and its evidence row still stand.
          if (operation === "write") writesState = true;
          else if (operation === "read") readsState = true;
          touchesDatabase = true;
          evidence.push({ kind: "database", source: "data-source", name: ds.name, line: ds.line, operation });
          break;
        }
        case "api-call":
          callsExternal = true;
          evidence.push({ kind: "http", source: "data-source", name: ds.name, line: ds.line, operation: "call" });
          break;
        case "queue-publish":
          emitsEvents = true;
          evidence.push({ kind: "queue", source: "data-source", name: ds.name, line: ds.line, operation: "publish" });
          break;
        case "queue-consume":
          consumesEvents = true;
          evidence.push({ kind: "queue", source: "data-source", name: ds.name, line: ds.line, operation: "consume" });
          break;
        case "state":
        case "store":
        case "context":
          evidence.push({ kind: "state", source: "data-source", name: ds.name, line: ds.line, operation: "use" });
          break;
        case "env":
          evidence.push({ kind: "config", source: "data-source", name: ds.name, line: ds.line, operation: "read" });
          break;
        default:
          break; // prop / import: not boundaries
      }
    }

    // Declared routes: an API route SERVES requests; a frontend route is UI.
    for (const r of a.routes) {
      if (r.kind === "api") {
        servesRequests = true;
        evidence.push({ kind: "http", source: "route", name: `${r.httpMethod ?? "ANY"} ${r.path}`, line: r.line, operation: "serve" });
      } else {
        evidence.push({ kind: "ui", source: "route", name: r.path, line: r.line, operation: "route" });
      }
    }
    for (const s of a.screens) {
      evidence.push({ kind: "ui", source: "screen", name: s.name, operation: "render" });
    }

    // A `db-write` mutation is a second, independent witness of a write — but
    // only where the file is already known to touch the database. The mutation
    // rules for several languages match a bare `save`/`update`/`add` with no
    // receiver gate, so on their own they would import that noise into every
    // profile.
    if (touchesDatabase && !writesState) {
      const dbWrite = a.dataMutations.find((m) => m.kind === "db-write");
      if (dbWrite) {
        writesState = true;
        evidence.push({
          kind: "database",
          source: "data-mutation",
          name: dbWrite.target,
          line: dbWrite.line,
          operation: "write",
        });
      }
    }

    if (evidence.length === 0) continue;

    const boundaries = [...new Set(evidence.map((e) => e.kind))].sort();
    const roles = [...new Set(boundaries.map((b) => BOUNDARY_ROLE[b]))].sort();
    const concernCount = roles.filter((r) => !UBIQUITOUS_ROLES.has(r)).length;

    evidence.sort((x, y) => (x.line ?? Number.MAX_SAFE_INTEGER) - (y.line ?? Number.MAX_SAFE_INTEGER) || byOrdinal(x.name, y.name));

    out.push({
      filePath: a.filePath,
      ...attributeToSymbols(a, evidence),
      boundaries,
      roles,
      concernCount,
      externalPackageCount: externals.size,
      readsState,
      writesState,
      emitsEvents,
      consumesEvents,
      servesRequests,
      callsExternal,
      evidenceCount: evidence.length,
      evidence: evidence.slice(0, EVIDENCE_CAP),
    });
  }

  out.sort((x, y) => y.concernCount - x.concernCount || byOrdinal(x.filePath, y.filePath));
  return out;
}
