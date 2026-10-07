import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, jsonObject } from "../shared/declared-package.js";

/** `haxelib.json`: `"dependencies": { "tink_web": "", "hxnodejs": "12.0.0" }`. */
function parseHaxelibJson(text: string, declaredIn: string): DeclaredPackage[] {
  const deps = jsonObject(text)?.dependencies as Record<string, unknown> | undefined;
  if (!deps || typeof deps !== "object") return [];
  return Object.entries(deps).map(([name, v]) => declared(name, typeof v === "string" && v && !/^git:/.test(v) ? v : null, "haxelib", "prod", declaredIn));
}

/** A build file `*.hxml`: `-lib tink_web`, `--library hxnodejs:12.0.0`. */
function parseHxml(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  for (const m of text.matchAll(/^\s*(?:-lib|--library)\s+([\w.-]+)(?::([\w.-]+))?/gm)) {
    if (!out.some((p) => p.name === m[1])) out.push(declared(m[1]!, m[2] ?? null, "haxelib", "prod", declaredIn));
  }
  return out;
}

export const haxelibPackageManager: PackageManagerSpec = {
  ecosystem: "haxelib",
  manifests: [
    { files: ["haxelib.json"], parse: (text, file) => parseHaxelibJson(text, file.declaredIn) },
    { files: ["*.hxml"], parse: (text, file) => parseHxml(text, file.declaredIn) },
  ],
  // `import tink.web.routing.*` comes from the `tink_web` library; `haxe.*`/`sys.*`/`js.*` are the standard library.
  importKey: (s) => (/^(?:haxe|sys|js|python|php|cpp|cs|java|lua|hl|neko|flash|eval)\./.test(s) ? null : s.split(".").slice(0, 2).join("_").toLowerCase()),
  prefixMatch: { separator: "_", bidirectional: true },
};
