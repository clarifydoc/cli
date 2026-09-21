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
  /**
   * Stable identifier, used as the `dispatch:<id>` strategy tag on every link
   * this resolver emits. It is what makes a synthetic link attributable to the
   * framework rule that invented it — before this existed, the only per-resolver
   * identity was the class object or its `priority`, neither of which survives
   * into the artifact. Lower-case, hyphenated, and stable across releases:
   * changing one silently rewrites provenance in every committed fixture.
   */
  readonly id: string;

  /** Languages this resolver applies to; core pre-filters analyses to these. */
  readonly languages: Language[];

  /**
   * Run order across ALL resolvers (lower runs first). Observable: synthetic
   * links are appended in resolver order, so the order must be stable
   * regardless of which plugin meta carries the resolver.
   */
  readonly priority: number;

  /**
   * Inspect the (already per-file analyzed) project and return extra symbol
   * links bridging dispatch sites to their handlers. Must be side-effect free.
   */
  resolve(analyses: FileAnalysis[]): SymbolLink[];
}
