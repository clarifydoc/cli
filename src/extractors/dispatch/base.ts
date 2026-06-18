import type { FileAnalysis, SymbolLink, Language } from "../../types/analysis.js";

/**
 * A project-level resolver for *dispatch indirection* — call patterns where the
 * caller and the code that runs have no direct, name-resolvable call edge
 * because a mediator / command bus sits between them (e.g. MediatR
 * `ISender.Send(new XQuery())` → `IRequestHandler<XQuery>.Handle`). The generic
 * symbol linker can't see across that boundary, so each language plugin that has
 * such a pattern contributes the synthetic `caller → handler` links here.
 *
 * Mirrors the entity `reconcileProject` design: core invokes every resolver
 * generically (see `resolveProjectDispatch`) and never names a framework itself.
 */
export interface DispatchResolver {
  /** Languages this resolver applies to; core pre-filters analyses to these. */
  readonly languages: Language[];

  /**
   * Inspect the (already per-file analyzed) project and return extra symbol
   * links bridging dispatch sites to their handlers. Must be side-effect free.
   */
  resolve(analyses: FileAnalysis[]): SymbolLink[];
}
