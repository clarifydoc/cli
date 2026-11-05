import type { FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../../types/analysis.js";
import type { DispatchResolver } from "../../../dispatch/base.js";
import { type ClassAt, DRF_GENERIC_VIEW, DRF_SERIALIZER, PythonClassIndex, type SaveMode, saveModeOf, serializerRuns } from "./drf.js";

/**
 * A DRF serializer's `is_valid()` and `save()` run the project's methods on it,
 * which nothing in the source calls:
 *
 *   serializer = ClubSerializer(data=request.data)   # or self.get_serializer(data=…)
 *   serializer.is_valid(raise_exception=True)        # validate_<field>(), the fields' validators=[…], validate()
 *   serializer.save()                                # create() — update() when built with an instance
 *
 * The serializer's class is the local's type (`ClubSerializer(…)`), or the
 * view's `serializer_class` where the local is `self.get_serializer(…)`, or
 * where it is the `serializer` DRF hands `perform_create` / `perform_update`.
 * `save()` is joined only where every construction of the local in the
 * function says whether it has an instance (`perform_create` creates,
 * `perform_update` updates). A local typed two ways, a view picking its
 * serializer at run time (`get_serializer_class`) or a class that is not a
 * project serializer joins nothing.
 */
export class DrfSerializerResolver implements DispatchResolver {
  readonly id = "drf-serializer";
  readonly languages: Language[] = ["python"];
  readonly priority = 62;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const sites = analyses.filter((a) => a.classes.some((c) => c.methods.some(callsSerializer)) || a.functions.some(callsSerializer));
    if (sites.length === 0) return [];
    const index = new PythonClassIndex(analyses);
    const isSerializer = (c: ClassAt | null): c is ClassAt => !!c && index.chainOf(c).external.some((b) => DRF_SERIALIZER.test(b));

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const scan = (a: FileAnalysis, fn: FunctionInfo, symbol: string, view: ClassAt | null) => {
      /** The serializer of the class `fn` is a method of, where it is a DRF view. */
      const viewSerializer = (): ClassAt | null => {
        if (!view) return null;
        const { chain, external } = index.chainOf(view);
        return external.some((b) => DRF_GENERIC_VIEW.test(b)) ? index.viewSerializer(chain) : null;
      };
      /** One mode, when every call `named` in the function states the same; else null. */
      const modeOf = (named: (callName: string) => boolean): SaveMode | null => {
        const modes = new Set(fn.calls.filter((c) => named(c.name)).map((c) => saveModeOf(c.key)));
        return modes.size === 1 ? [...modes][0]! : null;
      };
      const typeOf = (local: string): { serializer: ClassAt; mode: SaveMode | null } | null => {
        const entries = (fn.localTypes ?? []).filter((l) => l.name === local);
        if (entries.length > 0) {
          const kinds = new Set(entries.map((l) => l.type || l.from || ""));
          if (kinds.size !== 1) return null;
          const e = entries[0]!;
          if (e.type) {
            const serializer = index.classNamed(e.type, a);
            if (!isSerializer(serializer)) return null;
            return { serializer, mode: modeOf((n) => n === e.type || n.endsWith(`.${e.type}`)) };
          }
          if (e.from === "self.get_serializer()") {
            const serializer = viewSerializer();
            return serializer ? { serializer, mode: modeOf((n) => n === "self.get_serializer") } : null;
          }
          return null;
        }
        // `def perform_update(self, serializer)`: DRF hands it the serializer it built for the request.
        const hook = /^perform_(create|update)$/.exec(fn.name);
        const param = fn.params.filter((p) => p.name !== "self")[0];
        if (!hook || param?.name !== local) return null;
        const serializer = viewSerializer();
        return serializer ? { serializer, mode: hook[1] as SaveMode } : null;
      };
      for (const c of fn.calls) {
        const m = /^([A-Za-z_]\w*)\.(is_valid|save)$/.exec(c.name);
        if (!m || m[1] === "self") continue;
        const t = typeOf(m[1]!);
        if (!t) continue;
        const call = m[2] === "is_valid" ? "is_valid" : t.mode ? (`save:${t.mode}` as const) : null;
        if (!call) continue;
        serializerRuns(index, t.serializer, call, (file, targetSymbol, line) => {
          const key = `${a.filePath}\0${symbol}\0${c.line}\0${file.filePath}\0${targetSymbol}`;
          if (seen.has(key)) return;
          seen.add(key);
          links.push({ sourceFile: a.filePath, sourceSymbol: symbol, sourceLine: c.line, callName: c.name, targetFile: file.filePath, targetSymbol, targetLine: line, resolvedBy: "text", confidence: "INFERRED" });
        });
      }
    };
    for (const a of sites) {
      for (const f of a.functions) if (callsSerializer(f)) scan(a, f, f.name, null);
      for (const cls of a.classes) for (const m of cls.methods) if (callsSerializer(m)) scan(a, m, `${cls.name}.${m.name}`, { cls, file: a });
    }
    return links;
  }
}

function callsSerializer(fn: FunctionInfo): boolean {
  return fn.calls.some((c) => /^[A-Za-z_]\w*\.(?:is_valid|save)$/.test(c.name) && !c.name.startsWith("self."));
}
