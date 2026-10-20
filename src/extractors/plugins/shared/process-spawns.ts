import type { ImportInfo } from "../../../types/analysis.js";

/**
 * Programs a file starts as another process — a script of the repository it
 * RUNS rather than loads, so an import with `executes: true` (as Bash's
 * `./scripts/build.sh`): a dependency edge, and what keeps the script alive
 * for dead code, with nothing of it in scope.
 *
 *   fork("./worker.js") · spawn("node", ["tools/import.js"]) · execSync("python tools/gen.py")
 *   new Worker(new URL("./resize.js", import.meta.url)) · path.join(__dirname, "jobs", "nightly.js")   (JS/TS)
 *   subprocess.run([sys.executable, "tools/gen.py"]) · os.system("bash deploy.sh")
 *   os.path.join(os.path.dirname(__file__), "migrate.py")                                           (Python)
 *   exec.Command("python3", "scripts/report.py") · exec.Command("./scripts/run.sh")                 (Go)
 *
 * A path anchored on the file's own directory (`__dirname`, `import.meta.url`,
 * `os.path.dirname(__file__)`, `./`) is relative to it (`./x`); a plain one is
 * relative to where the program runs — usually the project root — and stays
 * unanchored (`tools/import.js`), resolved from the project root or by name.
 * Only paths with a script's extension count: `spawn("git", …)` starts a tool.
 */

const SCRIPT = /^[\w./@-]+\.(?:js|mjs|cjs|ts|mts|py|sh|bash|rb|pl|php|ps1)$/;

const SPAWN_CALLS: Record<"js" | "python" | "go", RegExp> = {
  // Called bare (imported) or on `child_process` — `/x/.exec("a.js")` is a regex.
  js: /(?:(?<![\w$.])|(?<=\b(?:child_process|childProcess|cp)\.))(?:fork|spawn|spawnSync|execFile|execFileSync|exec|execSync|execa|execaSync|execaNode|execaCommand)\s*\(|\bnew\s+Worker\s*\(/g,
  python: /\b(?:subprocess\.(?:run|call|check_call|check_output|Popen)|os\.(?:system|popen|exec\w*|spawn\w*)|asyncio\.create_subprocess_(?:exec|shell))\s*\(/g,
  go: /\bexec\.Command(?:Context)?\s*\(/g,
};

const GATE: Record<"js" | "python" | "go", RegExp> = {
  js: /child_process|worker_threads|\bexeca\b|new\s+Worker\s*\(/,
  python: /\bsubprocess\b|\bos\.(?:system|popen|exec|spawn)|create_subprocess_/,
  go: /\bexec\.Command/,
};

/** The argument text of the call whose `(` is at `open` (balanced, strings skipped). */
function argText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 2000; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return "";
}

/** A path joined onto the file's own directory: `path.join(__dirname, "a", "b.js")` → `./a/b.js`. */
function anchoredJoins(args: string): string[] {
  const out: string[] = [];
  const re = /(?:path\.)?(?:join|resolve)\(\s*(?:__dirname|import\.meta\.dirname|os\.path\.dirname\(\s*(?:os\.path\.(?:abspath|realpath)\(\s*)?__file__\s*\)?\s*\))\s*,\s*((?:(?:"[^"']+"|'[^"']+')\s*(?:,\s*)?)+)\)/g;
  for (const m of args.matchAll(re)) {
    const parts = [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((p) => p[1]!);
    out.push("./" + parts.join("/").replace(/^\.\//, ""));
  }
  for (const m of args.matchAll(/new\s+URL\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*,\s*import\.meta\.url/g)) out.push(m[1]!);
  return out;
}

export function spawnedScripts(text: string, lang: "js" | "python" | "go"): Array<{ path: string; line: number }> {
  if (!GATE[lang].test(text)) return [];
  const out: Array<{ path: string; line: number }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SPAWN_CALLS[lang])) {
    const open = m.index! + m[0].length - 1;
    const args = argText(text, open);
    const line = text.slice(0, m.index).split("\n").length;
    const add = (p: string) => {
      const path = p.replace(/^\.\/(?=\.\.\/)/, "");
      if (!SCRIPT.test(path.replace(/^\.\.?\//, "")) || path.startsWith("/") || seen.has(path)) return;
      seen.add(path);
      out.push({ path, line });
    };
    const anchored = anchoredJoins(args);
    for (const p of anchored) add(p);
    if (anchored.length) continue;
    // String literals: a path itself (`"./worker.js"`) or a command line (`"python tools/gen.py --x"`).
    for (const s of args.matchAll(/["'`]([^"'`$]+)["'`]/g)) {
      for (const word of s[1]!.split(/\s+/)) if (SCRIPT.test(word.replace(/^\.\.?\//, ""))) add(word);
    }
  }
  return out;
}

/** The spawned scripts as `executes` imports. */
export function spawnImports(text: string, lang: "js" | "python" | "go"): ImportInfo[] {
  return spawnedScripts(text, lang).map(({ path, line }) => ({ source: path, specifiers: [], isDefault: false, isNamespace: false, isType: false, line, executes: true }));
}
