import type { FileAnalysis } from "../../../types/analysis.js";
import type { RecordChoice } from "../../../types/language-plugin.js";
import { buildFilePathMap } from "../../shared/link-scoring.js";
import { constantValue, propLiterals, type Usage } from "./vuex.js";

/**
 * Which entries of a record of call results a component reads at run time are the ones its users pick —
 * `LanguagePluginMeta.recordChoice`:
 *
 *     const stores = { [Kind.Club]: useClubStore(), [Kind.Player]: usePlayerStore() };
 *     stores[props.kind].actions.createOne(body)        // under <Picker kind="player" /> and <Picker :kind="Kind.Club" />
 *
 * The values the component's users bind its prop to (`propLiterals`: a literal, a constant, or a prop of their own
 * handed on) are matched with the value each entry's key has (`'club'` as written, `Kind.Club` read in the module
 * declaring the enum); an entry no binding names is left out, and the ones kept carry the binding sites. Null when
 * an entry's key cannot be read, or no binding names any entry: the read then reaches every entry.
 */
export function recordChoice(analyses: readonly FileAnalysis[]): RecordChoice {
  const all = [...analyses];
  const byPath = new Map(all.map((a) => [a.filePath, a]));
  const ctx = { byPath, filePathMap: buildFilePathMap(all) };
  let bound: ReturnType<typeof propLiterals> | null = null;
  return (file, index, keys) => {
    if (index.kind !== "prop") return null;
    const from = byPath.get(file);
    if (!from) return null;
    const valueOf = (key: string): string | null => {
      const quoted = /^'(.*)'$/.exec(key);
      return quoted ? quoted[1]! : constantValue(from, key, ctx);
    };
    const values = new Map<string, string>();
    for (const key of keys) {
      const v = valueOf(key);
      if (v === null) return null;
      values.set(key, v);
    }
    bound ??= propLiterals(all, ctx.filePathMap, byPath, ctx);
    const usages = bound(file, index.name);
    const out = new Map<string, Usage[]>();
    for (const [key, value] of values) {
      const sites = usages.get(value);
      if (sites?.length) out.set(key, [...(out.get(key) ?? []), ...sites]);
    }
    return out.size > 0 ? out : null;
  };
}
