import type { Node } from "web-tree-sitter";
import type { ClassInfo, FileAnalysis, Language, SymbolLink } from "../../../../types/analysis.js";
import type { DispatchResolver } from "../../../dispatch/base.js";

/**
 * A Django management command runs by name, never by a call of its code:
 *
 *   call_command("close_season", "--dry-run")          # a test, a view, another command
 *   management.call_command("close_season")
 *
 * runs `<app>/management/commands/close_season.py`'s `Command`: Django builds
 * it, reads its options (`add_arguments`) and calls `handle`. The call's
 * literal name is its key (`django-command:<name>`, read by `djangoCommandKey`
 * in the plugin's call hooks); `DjangoCommandResolver` links the calling
 * function to those methods. A name is joined only when exactly one command
 * file answers it — in the caller's sub-project first, else in the whole
 * analysis — and a name built at run time is never a key.
 */

const KEY_PREFIX = "django-command:";
const COMMAND_FILE = /(?:^|\/)management\/commands\/([A-Za-z_]\w*)\.py$/;
/** What `call_command` runs on the command, in order: the parser's options, then the command itself. */
const RUN_METHODS = ["add_arguments", "handle"] as const;

/** `call_command("name", …)` / `management.call_command("name", …)` → `django-command:name`. */
export function djangoCommandKey(node: Node): string | null {
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  const leaf = fn.type === "identifier" ? fn.text : fn.type === "attribute" ? fn.childForFieldName("attribute")?.text : undefined;
  if (leaf !== "call_command") return null;
  const first = node.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment");
  if (!first || first.type !== "string" || first.namedChildren.some((c) => c.type === "interpolation")) return null;
  const name = first.namedChildren.filter((c) => c.type === "string_content").map((c) => c.text).join("");
  return /^[A-Za-z_]\w*$/.test(name) ? `${KEY_PREFIX}${name}` : null;
}

interface CommandDef {
  file: string;
  projectId: string | undefined;
  cls: ClassInfo;
}

export class DjangoCommandResolver implements DispatchResolver {
  readonly id = "django-command";
  readonly languages: Language[] = ["python"];
  readonly priority = 59;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const commands = new Map<string, CommandDef[]>();
    const classesByName = new Map<string, ClassInfo[]>();
    for (const a of analyses) {
      for (const c of a.classes) (classesByName.get(c.name) ?? classesByName.set(c.name, []).get(c.name)!).push(c);
      const m = COMMAND_FILE.exec(a.filePath);
      if (!m || m[1] === "__init__") continue;
      const cls = a.classes.find((c) => c.name === "Command");
      if (!cls) continue;
      (commands.get(m[1]!) ?? commands.set(m[1]!, []).get(m[1]!)!).push({ file: a.filePath, projectId: a.projectId, cls });
    }
    if (commands.size === 0) return [];

    /** The method `call_command` runs: the command's own, else the one base declaring it (bases named once in the analysis). */
    const methodOf = (cls: ClassInfo, name: string): { cls: ClassInfo; line: number } | null => {
      let at: ClassInfo | undefined = cls;
      for (let hops = 0; at && hops < 6; hops++) {
        const own = at.methods.find((m) => m.name === name);
        if (own) return { cls: at, line: own.line };
        const bases: ClassInfo[] = at.extends ? classesByName.get(at.extends.replace(/^.*\./, "")) ?? [] : [];
        at = bases.length === 1 ? bases[0] : undefined;
      }
      return null;
    };
    const fileOf = new Map<ClassInfo, string>();
    for (const a of analyses) for (const c of a.classes) fileOf.set(c, a.filePath);

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const scan = (a: FileAnalysis, symbol: string, calls: FileAnalysis["functions"][number]["calls"]): void => {
      for (const c of calls) {
        if (!c.key?.startsWith(KEY_PREFIX)) continue;
        const all = commands.get(c.key.slice(KEY_PREFIX.length)) ?? [];
        const own = all.filter((d) => d.projectId === a.projectId);
        const pick = own.length > 0 ? own : all;
        if (pick.length !== 1) continue;
        const def = pick[0]!;
        for (const name of RUN_METHODS) {
          const m = methodOf(def.cls, name);
          if (!m) continue;
          const targetFile = fileOf.get(m.cls) ?? def.file;
          const targetSymbol = `${m.cls.name}.${name}`;
          const id = `${a.filePath}\0${symbol}\0${targetFile}\0${targetSymbol}`;
          if (seen.has(id)) continue;
          seen.add(id);
          links.push({ sourceFile: a.filePath, sourceSymbol: symbol, sourceLine: c.line, callName: c.name, targetFile, targetSymbol, targetLine: m.line, resolvedBy: "text", confidence: "INFERRED", relation: "dispatch" });
        }
      }
    };
    for (const a of analyses) {
      for (const f of a.functions) scan(a, f.name, f.calls);
      for (const cls of a.classes) for (const m of cls.methods) scan(a, `${cls.name}.${m.name}`, m.calls);
    }
    return links;
  }
}
