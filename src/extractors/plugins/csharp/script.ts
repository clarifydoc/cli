import type { ImportInfo } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";

/**
 * `#r "nuget: Dapper, 2.1.0"` / `#r "lib/Foo.dll"` and `#load "helpers.csx"` —
 * the two directives C# script (`.csx`: dotnet-script, Roslyn scripting)
 * adds to the language. The grammar knows neither: it wraps them in an ERROR
 * node that can swallow the line after.
 */
const DIRECTIVE_RE = /^[ \t]*#(r|load)[ \t]+"([^"\r\n]+)"/;

/**
 * Blank the script directives (keeping every line, so line numbers stay
 * true) and give them back as imports once extraction has run: `#load` names
 * a file the way `#include` does, and `#r "nuget: X"` names the package that
 * `using X;` reads from — which is how a script's `#r "nuget: Dapper"` reaches
 * the Dapper framework hint. A `#r` of a local assembly path names no source,
 * so it is only blanked.
 */
export function preprocessCsharpScript(rawSource: string, relativePath: string): PreprocessOutcome | null {
  if (!relativePath.toLowerCase().endsWith(".csx")) return null;
  const imports: ImportInfo[] = [];
  const lines = rawSource.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE_RE.exec(lines[i]!);
    if (!m) continue;
    lines[i] = lines[i]!.endsWith("\r") ? "\r" : "";
    changed = true;
    const target = m[2]!.trim();
    const line = i + 1;
    if (m[1] === "load") {
      const source = /^(?:\.{1,2}\/|\/)/.test(target) ? target : `./${target}`;
      imports.push({ source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line });
    } else {
      const pkg = /^nuget:\s*([^,\s]+)/i.exec(target);
      if (pkg) imports.push({ source: pkg[1]!, specifiers: [], isDefault: false, isNamespace: true, isType: false, line });
    }
  }
  if (!changed) return null;
  return {
    sourceText: lines.join("\n"),
    language: "csharp",
    postExtract(analysis) {
      analysis.imports = [...imports, ...analysis.imports].sort((a, b) => a.line - b.line);
    },
  };
}
