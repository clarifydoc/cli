import type { FileAnalysis } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { withInheritedGuards, type GuardAttr } from "../../../shared/route-metadata.js";
import { CS_GROUP_CALL, CS_GROUP_METHOD, type CsGroupCallFact, type CsGroupMethodFact } from "./minimal-api.js";

/**
 * Minimal-API guards declared where the group is used, not where it is built:
 * `app.MapClubsApi().RequireAuthorization()` guards every endpoint the
 * `MapClubsApi` method maps on the group it returns. Per file the extractor
 * records each such method's routes (`cs:group-method`) and each call with a
 * guard chained on it (`cs:group-call`); this pass joins them by the method's
 * name — the caller's own sub-project first, a name two methods share there
 * joins neither.
 */
export const minimalApiGroupGuards: RouteResolver = {
  id: "minimal-api-group-guards",
  languages: ["csharp"],
  priority: 25,
  resolve(analyses: FileAnalysis[]): void {
    const methods = new Map<string, Array<{ analysis: FileAnalysis; lines: number[] }>>();
    const calls: Array<{ analysis: FileAnalysis; call: CsGroupCallFact }> = [];
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === CS_GROUP_METHOD && f.owner) {
          (methods.get(f.owner) ?? methods.set(f.owner, []).get(f.owner)!).push({ analysis: a, lines: (f.data as CsGroupMethodFact).lines });
        } else if (f.kind === CS_GROUP_CALL) {
          calls.push({ analysis: a, call: f.data as CsGroupCallFact });
        }
      }
    }
    if (methods.size === 0 || calls.length === 0) return;
    const byFile = new Map<FileAnalysis, Map<number, GuardAttr[]>>();
    for (const { analysis, call } of calls) {
      const all = methods.get(call.callee) ?? [];
      const own = all.filter((m) => m.analysis.projectId === analysis.projectId);
      const pick = own.length > 0 ? own : all;
      if (pick.length !== 1) continue;
      const target = pick[0]!;
      const guards = call.guards.map(guardAttr);
      const lines = byFile.get(target.analysis) ?? byFile.set(target.analysis, new Map()).get(target.analysis)!;
      for (const line of target.lines) lines.set(line, [...(lines.get(line) ?? []), ...guards]);
    }
    for (const [analysis, lines] of byFile) {
      analysis.routes = analysis.routes.map((r) => {
        const guards = r.kind === "api" ? lines.get(r.line) : undefined;
        return guards ? withInheritedGuards(r, guards) : r;
      });
    }
  },
};

/** `RequireAuthorization("Coach")` → policy Coach; `AllowAnonymous` → anonymous. */
function guardAttr(text: string): GuardAttr {
  if (text === "AllowAnonymous") return { text, anonymous: true };
  return { text, policies: [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) };
}
