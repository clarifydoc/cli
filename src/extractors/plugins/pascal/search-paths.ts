import type { ModuleSearchPathSpec } from "../../../types/language-plugin.js";

/**
 * Where Delphi and Lazarus find a unit a `uses` names, as the project files say.
 * Leaf code: the manifest imports it.
 *
 * - `.dproj` (MSBuild): `DCC_UnitSearchPath` per `PropertyGroup`, the groups every
 *   build reads (no condition, or the `$(Base)` one) before platform and
 *   configuration groups; `DCCReference Include="Win\Garage.pas"` names a unit's file.
 * - `.lpi` (Lazarus): `OtherUnitFiles Value="…"` in each build mode's search paths;
 *   a project unit's `Filename Value="…"` names its file.
 *
 * Entries holding a macro (`$(DCC_UnitSearchPath)`, `$(TargetOS)`) are left out:
 * what they expand to is the IDE's, not the project's.
 */
export const pascalSearchPaths: ModuleSearchPathSpec = {
  files: ["*.dproj", "*.lpi"],
  glob: { deep: 1, limit: 8 },
  parse(text, path) {
    return /\.lpi$/i.test(path) ? lazarusPaths(text) : delphiPaths(text);
  },
  pathImportsPin: true,
};

/** `a;b\c;$(X)` → `["a", "b/c"]`. */
function splitPaths(value: string): string[] {
  return value.split(";").map((p) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "")).filter((p) => p && !p.includes("$("));
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return m ? m[1]!.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&") : null;
}

function delphiPaths(text: string): { dirs: string[]; files: string[] } {
  const general: string[] = [];
  const specific: string[] = [];
  for (const g of text.matchAll(/<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi)) {
    const condition = attr(g[1]!, "Condition");
    const into = !condition || /'\$\(Base\)'/i.test(condition) ? general : specific;
    for (const v of g[2]!.matchAll(/<DCC_UnitSearchPath>([\s\S]*?)<\/DCC_UnitSearchPath>/gi)) into.push(...splitPaths(v[1]!));
  }
  const files: string[] = [];
  for (const r of text.matchAll(/<DCCReference\b([^>]*)>/gi)) {
    const include = attr(r[1]!, "Include");
    if (include && /\.(?:pas|pp)$/i.test(include)) files.push(include.replace(/\\/g, "/"));
  }
  return { dirs: [...new Set([...general, ...specific])], files };
}

function lazarusPaths(text: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  for (const m of text.matchAll(/<OtherUnitFiles\b([^>]*)\/?>/gi)) dirs.push(...splitPaths(attr(m[1]!, "Value") ?? ""));
  const files: string[] = [];
  for (const u of text.matchAll(/<Unit\d*>([\s\S]*?)<\/Unit\d*>/gi)) {
    const name = /<Filename\b([^>]*)\/?>/i.exec(u[1]!);
    const file = name ? attr(name[1]!, "Value") : null;
    if (file && /\.(?:pas|pp)$/i.test(file)) files.push(file.replace(/\\/g, "/"));
  }
  return { dirs: [...new Set(dirs)], files };
}
