import type { DeclaredProject } from "../../../types/language-plugin.js";
import { blankStringAwareComments, matchingParen, splitTopLevelCommas } from "../shared/text-scan.js";

const VAL = /^(?:lazy\s+)?val\s+(`[^`]+`|\w+)\s*(?::[^=\n]+)?=/gm;
const PROJECT_RHS = /^\s*\(?\s*(?:projectMatrix|crossProject|project|Project)\b/;
const IN_FILE = /\bin\s*\(?\s*file\s*\(\s*"([^"]*)"\s*\)/;
const PROJECT_FILE = /\bProject\s*\([^)]*?file\s*\(\s*"([^"]*)"\s*\)/;
const BARE_PROJECT = /^\s*\(?\s*project\s*(?:$|[.\n)])/;
/** One argument of `dependsOn` / `aggregate`: a project val (maybe `` `x-y` ``, a `.jvm` axis, a `% "test->test"` scope). */
const REFERENCE = /^\s*\(?\s*(`[^`]+`|\w+)(?:\.(?:jvm|js|native))?\s*\)?\s*(?:%.*)?$/s;

const unquote = (name: string) => name.replace(/^`|`$/g, "");

/**
 * The sub-projects an sbt build declares: each `lazy val x = (project in file("dir"))` (also `projectMatrix`,
 * `crossProject`, `Project("x", file("dir"))`, a bare `project` rooted at the val's name) and the projects its
 * `.dependsOn(…)` / `.aggregate(…)` calls name — by val name, never by directory.
 */
export function sbtProjects(text: string): DeclaredProject[] {
  const source = blankStringAwareComments(text, { quotes: '"' });
  const heads = [...source.matchAll(VAL)];
  const out: DeclaredProject[] = [];
  heads.forEach((head, i) => {
    const rhs = source.slice(head.index! + head[0].length, heads[i + 1]?.index ?? source.length);
    if (!PROJECT_RHS.test(rhs)) return;
    const name = unquote(head[1]!);
    const path = IN_FILE.exec(rhs)?.[1] ?? PROJECT_FILE.exec(rhs)?.[1] ?? (BARE_PROJECT.test(rhs) ? name : null);
    if (path === null) return;
    const references: string[] = [];
    for (const call of rhs.matchAll(/\.(?:dependsOn|aggregate)\s*\(/g)) {
      const open = call.index! + call[0].length - 1;
      const close = matchingParen(rhs, open);
      if (close < 0) continue;
      for (const arg of splitTopLevelCommas(rhs.slice(open + 1, close))) {
        const ref = REFERENCE.exec(arg);
        if (ref) references.push(unquote(ref[1]!));
      }
    }
    out.push({ name, path: path.replace(/^\.\//, "").replace(/\/+$/, "") || ".", references });
  });
  return out;
}
