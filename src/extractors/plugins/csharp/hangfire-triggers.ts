import type { Node } from "web-tree-sitter";
import type { ClassInfo, FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * Hangfire recurring jobs run by their id.
 *
 *     RecurringJob.AddOrUpdate<IKitService>(WashKitsId, s => s.WashKits(ct), Cron.Daily);   // registers
 *     RecurringJob.TriggerJob(Jobs.WashKitsId);                                              // runs it now
 *
 * The trigger names no method: the work it starts is the lambda of the registration with the same id. This reads both
 * calls' arguments (`CallInfo.args`, stated by `csharpHangfireArgs`) and links the function that triggers a job to the
 * method its registration runs — on the one class implementing the interface the registration names (two or more
 * implementers refuse, so a decoy is never linked), else on the type itself, else (a lambda over a bare call,
 * `() => ScanLibraries(false)`) on the class that registers it. An id is its string literal, or a `const` string the
 * code reads by name and a class of the project declares (`ClassInfo.fieldValues`); an id that cannot be read, or that
 * two registrations give different handlers, links nothing.
 */

const REGISTER = /(?:^|\.)(?:RecurringJob|\w*[rR]ecurringJob\w*)\.AddOrUpdate(?:<[^>]*>)?$/;
const TRIGGER = /(?:^|\.)(?:RecurringJob|\w*[rR]ecurringJob\w*)\.(?:TriggerJob|Trigger)$/;

/** The arguments the resolver reads off a Hangfire call: `[id]` for a trigger, `[id, type, method]` for a registration. */
export function csharpHangfireArgs(node: Node): string[] | null {
  if (node.type !== "invocation_expression") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_access_expression") return null;
  const nameNode = fn.childForFieldName("name");
  const name = nameNode?.type === "generic_name" ? nameNode.namedChildren[0]?.text : nameNode?.text;
  const receiver = fn.childForFieldName("expression")?.text ?? "";
  if (!name || !/^(?:[\w.]*\.)?\w*[rR]ecurringJob\w*$/.test(receiver)) return null;
  const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((c) => c.type === "argument").map((c) => c.namedChildren[0]);
  const id = args[0]?.text;
  if (!id) return null;
  if (name === "TriggerJob" || name === "Trigger") return [id];
  if (name !== "AddOrUpdate") return null;
  const lambda = args[1];
  if (lambda?.type !== "lambda_expression") return null;
  const body = lambda.childForFieldName("body") ?? lambda.namedChildren[lambda.namedChildren.length - 1];
  const call = body?.type === "invocation_expression" ? body.childForFieldName("function") : null;
  const method = call?.type === "identifier" ? call.text : call?.type === "member_access_expression" ? call.childForFieldName("name")?.text : null;
  if (!method) return null;
  // `AddOrUpdate<IKitService>(…)`: the type argument list is the generic name's second child.
  const type = nameNode?.type === "generic_name" ? nameNode.namedChildren[1]?.text.replace(/^<|>$/g, "").trim() ?? "" : "";
  if (nameNode?.type === "generic_name" && !/^[A-Za-z_][\w.]*$/.test(type)) return null;
  return [id, type, method];
}

const bare = (t: string): string => t.trim().replace(/<.*$/, "").split(".").pop()!.trim();

export class CSharpHangfireTriggerResolver implements DispatchResolver {
  readonly id = "hangfire-trigger";
  readonly languages: Language[] = ["csharp"];
  readonly priority = 12;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    type Callable = { file: string; symbol: string; fn: FunctionInfo; cls: ClassInfo | null };
    const callables: Callable[] = [];
    const classes = new Map<string, Array<{ cls: ClassInfo; file: string }>>();
    for (const a of analyses) {
      for (const fn of a.functions) callables.push({ file: a.filePath, symbol: fn.name, fn, cls: null });
      for (const cls of a.classes) {
        (classes.get(cls.name) ?? classes.set(cls.name, []).get(cls.name)!).push({ cls, file: a.filePath });
        for (const m of cls.methods) callables.push({ file: a.filePath, symbol: `${cls.name}.${m.name}`, fn: m, cls });
      }
    }
    const isJobCall = (c: { name: string; args?: string[] }, re: RegExp) => re.test(c.name) && !!c.args?.length;
    if (!callables.some((c) => c.fn.calls.some((x) => isJobCall(x, TRIGGER)))) return [];

    // An id's value: a string literal, or a const the named class (else the caller's own class, else the one project class) declares.
    const valueOf = (expr: string, own: ClassInfo | null): string | null => {
      const literal = /^@?"([^"\\]*)"$/.exec(expr);
      if (literal) return literal[1]!;
      const m = /^(?:([\w.]*)\.)?([A-Za-z_]\w*)$/.exec(expr.trim());
      if (!m) return null;
      const [, holder, leaf] = m;
      const holders = holder ? (classes.get(holder.split(".").pop()!) ?? []).map((c) => c.cls) : own ? [own] : [];
      const values = new Set(holders.map((c) => c.fieldValues?.[leaf!]).filter((v): v is string => typeof v === "string"));
      if (values.size === 1) return [...values][0]!;
      if (holders.length > 0) return null;
      const all = new Set([...classes.values()].flat().map((c) => c.cls.fieldValues?.[leaf!]).filter((v): v is string => typeof v === "string"));
      return all.size === 1 ? [...all][0]! : null;
    };

    // The methods each registered id runs.
    const registered = new Map<string, Array<{ file: string; symbol: string; line: number }>>();
    const open = new Set<string>();
    for (const c of callables) {
      for (const call of c.fn.calls) {
        if (!isJobCall(call, REGISTER) || call.args!.length < 3) continue;
        const [idExpr, type, method] = call.args!;
        const id = valueOf(idExpr!, c.cls);
        if (id === null) continue;
        const targets: Array<{ file: string; symbol: string; line: number }> = [];
        const own = (cls: ClassInfo, file: string) => {
          for (const m of cls.methods.filter((x) => x.name === method)) targets.push({ file, symbol: `${cls.name}.${m.name}`, line: m.line });
        };
        if (!type) {
          if (c.cls) own(c.cls, c.file);
        } else {
          const named = classes.get(bare(type)) ?? [];
          // The type itself when it is a class; an interface only when exactly one class implements it.
          for (const t of named) if (t.cls.kind !== "interface") own(t.cls, t.file);
          if (named.some((t) => t.cls.kind === "interface")) {
            const impls: Array<{ cls: ClassInfo; file: string }> = [];
            for (const list of classes.values()) {
              for (const impl of list) {
                if ([impl.cls.extends, ...(impl.cls.implements ?? [])].some((b) => b && bare(b) === bare(type)) && !named.some((t) => t.cls === impl.cls)) impls.push(impl);
              }
            }
            if (impls.length === 1) own(impls[0]!.cls, impls[0]!.file);
          }
        }
        if (targets.length === 0) continue;
        const key = JSON.stringify(targets.map((t) => `${t.file}::${t.symbol}`).sort());
        const seen = registered.get(id);
        if (seen && JSON.stringify(seen.map((t) => `${t.file}::${t.symbol}`).sort()) !== key) open.add(id);
        else registered.set(id, targets);
      }
    }
    for (const id of open) registered.delete(id);
    if (registered.size === 0) return [];

    const links: SymbolLink[] = [];
    const done = new Set<string>();
    for (const c of callables) {
      for (const call of c.fn.calls) {
        if (!isJobCall(call, TRIGGER)) continue;
        const id = valueOf(call.args![0]!, c.cls);
        for (const t of (id !== null ? registered.get(id) : undefined) ?? []) {
          const key = `${c.file}::${c.symbol}::${t.file}::${t.symbol}`;
          if (done.has(key) || (t.file === c.file && t.symbol === c.symbol)) continue;
          done.add(key);
          links.push({
            sourceFile: c.file,
            sourceSymbol: c.symbol,
            sourceLine: call.line || c.fn.line,
            callName: `TriggerJob(${id})`,
            targetFile: t.file,
            targetSymbol: t.symbol,
            targetLine: t.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}
