import type { FileAnalysis, Language } from "../../types/analysis.js";
import type { ProjectContext } from "../../types/project.js";

/**
 * A project-level route pass: turns what per-file extraction could only see
 * in part — a base controller's route template two files away, a Django
 * urlconf `include("app.urls")`, a DRF `router.register` whose ViewSet lives
 * elsewhere — into the routes a caller actually requests.
 *
 * Plugins report facts per file (`FileAnalysis.routes`, `routeFacts`); a
 * resolver joins them across files through the `ProjectContext` and rewrites
 * `analysis.routes` in place. Core runs every resolver generically (see
 * `reconcileProjectRoutes`) and never names a framework, as with dispatch
 * resolvers and entity `reconcileProject`.
 *
 * Contract: REPLACE a route you change rather than mutating it — the runner
 * stamps `resolvedBy` on every row object it did not see before your pass,
 * which is how a rewritten or invented route stays attributable.
 */
export interface RouteResolver {
  /** Stable, lower-case, hyphenated id; stamped on rows as `resolvedBy`. */
  readonly id: string;
  /** Languages whose analyses this resolver sees. */
  readonly languages: readonly Language[];
  /** Run order across all resolvers (lower first), so output never depends on which meta carries a resolver. */
  readonly priority: number;
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void;
}
