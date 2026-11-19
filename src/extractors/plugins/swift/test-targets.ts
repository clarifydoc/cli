/**
 * The test targets a `Package.swift` gives a directory of their own: `.testTarget(name: "LeagueTests", path: "Tests/Custom")`
 * → `{ name: "LeagueTests", dir: "Tests/Custom" }`, the directory made project-relative from the manifest's own. A
 * target without `path:` sits on the default `Tests/<name>`, which the test command reads from the file's path, so it
 * is left out. Only a file named `Package.swift`, and only the arguments of the `.testTarget(` call itself.
 */
export function swiftTestTargets(lines: string[], filePath: string): Array<{ name: string; dir: string }> {
  if (!/(?:^|\/)Package\.swift$/.test(filePath)) return [];
  const text = lines.map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const base = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const out: Array<{ name: string; dir: string }> = [];
  const open = /\.testTarget\s*\(/g;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    // The call's own arguments: to the parenthesis that balances the opening one, strings skipped.
    let depth = 1;
    let i = open.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]!;
      if (c === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; }
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    const args = text.slice(open.lastIndex, i - 1);
    const name = /(?:^|[\s,(])name\s*:\s*"([^"\\]+)"/.exec(args)?.[1];
    // `path:` as this call's own argument, not one of a nested `.process(…)` resource rule (those say `.copy("x")`).
    const path = /(?:^|[\s,])path\s*:\s*"([^"\\]+)"/.exec(args.replace(/\.(?:process|copy|embedInCode)\s*\([^)]*\)/g, ""))?.[1];
    if (!name || !path) continue;
    const parts = [...(base ? base.split("/") : []), ...path.split("/")].filter((p) => p && p !== ".");
    if (parts.includes("..")) continue;
    out.push({ name, dir: parts.join("/") });
  }
  return out;
}
