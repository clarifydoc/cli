import type { FileAnalysis, FunctionInfo, RouteInfo } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { joinRoutePath } from "../../shared/route-paths.js";

/** `include_router(api, prefix=settings.api_prefix)`: the holder and the attribute the prefix reads. */
const SETTINGS_PREFIX = /^mount:([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;

/** `settings = AppSettings()`, `settings = get_settings()`: the entry of the function (or module) holding the line that binds the name. */
function localOf(a: FileAnalysis, line: number, head: string): { type: string; from?: string } | null | "ambiguous" {
  const fns = (a.functions ?? []).filter((f) => f.name !== "<setup>" && line >= f.line && line <= f.endLine);
  fns.sort((x, y) => y.line - x.line);
  const owner: FunctionInfo | undefined = fns[0] ?? (a.functions ?? []).find((f) => f.name === "<setup>");
  const entries = (owner?.localTypes ?? []).filter((l) => l.name === head);
  if (entries.length === 0) return null;
  if (entries.length > 1) return "ambiguous"; // no scope on localTypes: several entries may be separate declarations
  const e = entries[0]!;
  return { type: e.type, ...(e.from ? { from: e.from } : {}) };
}

/** The class a settings holder is an instance of: written type, else the declared return of the function it is built by. */
function settingsClass(file: FileAnalysis, local: { type: string; from?: string }, ctx: ProjectContext): ClassRef | null {
  if (local.type) return ctx.classes.resolve(file.filePath, local.type.replace(/^Optional\[(.*)\]$/, "$1"));
  const call = local.from ? /^([A-Za-z_]\w*)\(\)$/.exec(local.from) : null;
  if (!call) return null;
  const name = call[1]!;
  let owner: FileAnalysis | undefined = file;
  let fn = (file.functions ?? []).filter((f) => f.name === name);
  if (fn.length === 0) {
    const src = ctx.importIndex.localFor(file.filePath, name);
    owner = src ? ctx.fileOf(src) : undefined;
    fn = (owner?.functions ?? []).filter((f) => f.name === name);
  }
  const ret = fn.length === 1 ? fn[0]!.returnType : null;
  if (!owner || !ret || !/^[A-Za-z_][\w.]*$/.test(ret)) return null;
  return ctx.classes.resolve(owner.filePath, ret);
}

/** A class's own literal for an attribute, else the nearest base's. */
function ownValue(ref: ClassRef, attr: string, ctx: ProjectContext): string | undefined {
  const v = ctx.fileOf(ref.filePath)?.moduleValues?.[`${ref.cls.name}.${attr}`];
  return v !== undefined && !v.includes("${") ? v : undefined;
}

function classValue(ref: ClassRef, attr: string, ctx: ProjectContext): string | undefined {
  const own = ownValue(ref, attr, ctx);
  if (own !== undefined) return own;
  for (const anc of ctx.classes.ancestors(ref)) {
    if (!anc.ref) continue;
    const v = ownValue(anc.ref, attr, ctx);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * FastAPI `app.include_router(api, prefix=settings.api_prefix)` where `settings` is
 * an instance of a project settings class (built in place or by a function declaring
 * that class as its return) whose class states the attribute as a literal default
 * (`api_prefix: str = "/api"`, own or a base's). The default is the value: an
 * environment override is not read. A project subclass that states another value
 * (a per-environment settings class the instance may really be) leaves the mount
 * unresolved — `prefixUnresolved` stays, the prefix is never guessed.
 */
export const fastapiSettingsPrefix: RouteResolver = {
  id: "fastapi-settings-prefix",
  languages: ["python"],
  priority: 18,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    for (const a of analyses) {
      if (!(a.routes ?? []).some((r) => r.mount && r.prefixUnresolved && SETTINGS_PREFIX.test(r.prefixUnresolved))) continue;
      a.routes = a.routes.map((r): RouteInfo => {
        const m = r.mount && r.prefixUnresolved ? SETTINGS_PREFIX.exec(r.prefixUnresolved) : null;
        if (!m) return r;
        let holder: FileAnalysis | undefined = a;
        let local = localOf(a, r.line, m[1]!);
        if (local === "ambiguous") return r;
        if (!local) {
          // `from app.core.config import settings`: the instance is built in the module it is imported from.
          const src = ctx.importIndex.localFor(a.filePath, m[1]!);
          holder = src ? ctx.fileOf(src) : undefined;
          local = holder ? localOf(holder, 0, m[1]!) : null;
          if (local === "ambiguous") return r;
        }
        const ref = holder && local ? settingsClass(holder, local, ctx) : null;
        const value = ref ? classValue(ref, m[2]!, ctx) : undefined;
        if (value === undefined || !/^(?:\/[\w\-./{}]*)?$/.test(value)) return r;
        // A subclass the instance may really be, stating the attribute differently, makes the value unknowable here.
        if (ref!.cls && ctx.classes.descendants(ref!).some((d) => { const v = ownValue(d, m[2]!, ctx); return v !== undefined && v !== value; })) return r;
        const { prefixUnresolved: _, ...rest } = r;
        return { ...rest, path: value === "" ? r.path : joinRoutePath(r.path, value) };
      });
    }
  },
};
