import { EXTENSION_TO_LANGUAGE, NAMED_FILE_LANGUAGE, manifestFor } from "./extractors/registry.js";
import type { Language } from "./types/analysis.js";

/**
 * The README's language table, generated from the plugin registry so it
 * cannot fall behind what ships: each language under its extraction path,
 * with every extension and named file it claims. `npm run readme:facts`
 * writes it between the README's markers; a test fails when the two differ,
 * or when a language has no name below.
 */

/** How the README names each language. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  typescript: "TypeScript, with Vue and Svelte components", javascript: "JavaScript", csharp: "C#", python: "Python", java: "Java", kotlin: "Kotlin",
  pascal: "Pascal/Delphi", dfm: "DFM/LFM/FMX forms", php: "PHP", bash: "Bash/sh", fsharp: "F#", r: "R", julia: "Julia", zig: "Zig", ocaml: "OCaml",
  go: "Go", rust: "Rust", ruby: "Ruby", swift: "Swift", lua: "Lua", scala: "Scala, with Play routes", perl: "Perl",
  vb: "Visual Basic (VB.NET, VB6, VBScript)", sql: "SQL", c: "C", cpp: "C++ (and CUDA)", prisma: "Prisma", dart: "Dart/Flutter",
  elixir: "Elixir", erlang: "Erlang", objc: "Objective-C", haskell: "Haskell", clojure: "Clojure", blazor: "Blazor", html: "HTML",
  erb: "ERB", heex: "HEEx/EEx", handlebars: "Handlebars", liquid: "Liquid", velocity: "Velocity", razor: "Razor", gotemplate: "Go templates", qml: "QML",
  qtui: "Qt Designer", xaml: "XAML", jsp: "JSP", springxml: "Spring XML / MyBatis mappers / Android navigation graphs", jsight: "JSight",
  storyboard: "Interface Builder storyboards", terraform: "Terraform", protobuf: "Protocol Buffers", openapi: "OpenAPI", graphql: "GraphQL",
  wsdl: "WSDL", groovy: "Groovy, with Jenkinsfiles", powershell: "PowerShell", batch: "Windows batch", coffeescript: "CoffeeScript",
  crystal: "Crystal", raku: "Raku", racket: "Racket", scheme: "Scheme", commonlisp: "Common Lisp", haxe: "Haxe", mojo: "Mojo",
  scss: "SCSS", sass: "Sass", less: "Less", autohotkey: "AutoHotkey", autoit: "AutoIt", applescript: "AppleScript", nim: "Nim",
  dlang: "D", vlang: "V", fortran: "Fortran", serverless: "Serverless / AWS SAM", coredata: "Core Data models",
};

/** A named file as the README shows it, where the bare name would mislead. */
const NAMED_FILE_DISPLAY: Record<string, string> = { contents: "*.xcdatamodel/contents", routes: "conf/routes", jenkinsfile: "Jenkinsfile" };

/** Languages, in registry order, with what each claims and its path. */
export function languageRows(): Array<{ language: Language; name: string | undefined; path: "tree-sitter" | "regex"; claims: string[] }> {
  const claims = new Map<Language, string[]>();
  for (const [ext, language] of Object.entries(EXTENSION_TO_LANGUAGE)) (claims.get(language) ?? claims.set(language, []).get(language)!).push(ext);
  for (const [file, language] of NAMED_FILE_LANGUAGE) (claims.get(language) ?? claims.set(language, []).get(language)!).push(NAMED_FILE_DISPLAY[file] ?? file);
  return [...claims].map(([language, list]) => {
    const parsing = manifestFor(language)?.parsing;
    return { language, name: LANGUAGE_NAMES[language], path: parsing === "tree-sitter" || parsing === "custom" ? "tree-sitter" : "regex", claims: list };
  });
}

/** The table, as it stands between the README's `languages` markers. */
export function languageTable(): string {
  const rows = languageRows();
  const cell = (path: "tree-sitter" | "regex") =>
    rows.filter((r) => r.path === path).map((r) => `${r.name ?? r.language} (${r.claims.map((c) => `\`${c}\``).join(", ")})`).join(", ");
  return ["| Path | Languages (extensions and files) |", "|------|------------------------|", `| **tree-sitter** | ${cell("tree-sitter")} |`, `| **regex** | ${cell("regex")} |`].join("\n");
}

export const LANGUAGES_START = "<!-- languages:start (generated: npm run readme:facts) -->";
export const LANGUAGES_END = "<!-- languages:end -->";

/** `readme` with the table between its markers replaced by the generated one; unchanged when the markers are missing. */
export function withLanguageTable(readme: string): string {
  const i = readme.indexOf(LANGUAGES_START);
  const j = readme.indexOf(LANGUAGES_END);
  if (i < 0 || j < i) return readme;
  return `${readme.slice(0, i + LANGUAGES_START.length)}\n${languageTable()}\n${readme.slice(j)}`;
}
