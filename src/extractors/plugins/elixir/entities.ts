import type { FileAnalysis, Language } from "../../../types/analysis.js";
import { EntityExtractor, type EntityExtractResult } from "../../entities/base.js";

const PRELOAD_ROW = /^Repo\.preload\(:(\w+)\)$/;

/**
 * Ecto schemas are read per file by the regex spec (`schema` blocks, the
 * association macros); this extractor adds only the project-level join that
 * per-file reading cannot do: a `Repo.preload(:team)` row names an
 * association, and the schema it loads is whatever the project's schemas
 * declare under that association name (`belongs_to :team, League.Team`). The
 * row is typed only when every schema declaring the name agrees on the target;
 * otherwise it stays a read of unknown entity.
 */
export class ElixirEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["elixir"];

  extract(): EntityExtractResult {
    return { entities: [], relations: [] };
  }

  override reconcileProject(analyses: FileAnalysis[]): void {
    const elixir = analyses.filter((a) => a.language === "elixir");
    const targets = new Map<string, Set<string>>();
    for (const a of elixir) {
      for (const r of a.entityRelations ?? []) {
        if (r.orm !== "ecto") continue;
        const to = r.toEntity.split(".").pop()!;
        (targets.get(r.fromField) ?? targets.set(r.fromField, new Set()).get(r.fromField)!).add(to);
      }
    }
    if (targets.size === 0) return;
    for (const a of elixir) {
      for (const d of a.dataSources) {
        if (d.kind !== "database" || d.entity) continue;
        const field = PRELOAD_ROW.exec(d.name)?.[1];
        const to = field ? targets.get(field) : undefined;
        if (to?.size !== 1) continue;
        d.entity = [...to][0]!;
        d.target = d.entity;
      }
    }
  }
}
