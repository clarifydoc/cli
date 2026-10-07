import type { DiBinding } from "../../../types/analysis.js";
import { GO_TYPE_KEYWORDS, goResultTextAt, goResultTypes, goSimpleTypeName, matchingClose, splitGoTopLevel, stripGoComment } from "./syntax.js";

/**
 * Container registrations that bind an interface to an implementation, in
 * the Go DI libraries that state one:
 *
 *   wire  `wire.Bind(new(UserRepo), new(*PgRepo))`                → UserRepo → PgRepo
 *         `wire.InterfaceValue(new(UserRepo), &PgRepo{…})`        → UserRepo → PgRepo
 *   fx    `fx.Annotate(NewPgRepo, fx.As(new(UserRepo)))`          → UserRepo → what NewPgRepo builds
 *         `fx.ResultTags(\`name:"pg"\`)` beside it                 → reachable only as "pg"
 *   dig   `c.Provide(NewPgRepo, dig.As(new(UserRepo)))`            → UserRepo → what NewPgRepo builds
 *         `dig.Name("pg")` beside it                              → reachable only as "pg"
 *
 * Read anywhere in the file — inside `wire.NewSet(…)` / `wire.Build(…)`, a
 * package-level `var Module = fx.Options(…)`, a function body — and across
 * line breaks. Every registration seen is emitted, conflicting ones too: the
 * linker refuses to choose between them.
 *
 * What a provider BUILDS is only known when the provider is a func literal or
 * a function declared in this file: the one construction its body returns
 * (`return &PgRepo{…}`), else its declared result when that is a pointer
 * (`*PgRepo` — never an interface) or a struct declared here. A provider from
 * another file or package (`pg.NewRepo`) is not visible per file: the
 * registration names the provider function itself as `implementation`, and
 * the linker resolves it to that function's declared result when it is a
 * class (unique-or-nothing). Value groups (`group:"…"`) are injected as
 * slices, never as one implementation, and are skipped.
 */
export function extractGoDiBindings(lines: string[]): DiBinding[] {
  if (!lines.some((l) => l.includes("wire.") || l.includes("fx.") || l.includes("dig."))) return [];
  const code = lines.map(stripGoComment).join("\n");
  const lineAt = lineIndex(code);
  const out: DiBinding[] = [];
  const push = (service: string | null, implementation: string | null, at: number, via: string, extra: Partial<DiBinding> = {}) => {
    if (!service || !implementation || service === implementation) return;
    out.push({ service, implementation, line: lineAt(at), via, ...extra });
  };

  for (const m of code.matchAll(/\bwire\.Bind\(\s*new\(\s*([^()]+?)\s*\)\s*,\s*new\(\s*([^()]+?)\s*\)\s*,?\s*\)/g)) {
    push(goSimpleTypeName(m[1]!), goSimpleTypeName(m[2]!), m.index!, "wire.Bind");
  }
  for (const m of code.matchAll(/\bwire\.InterfaceValue\(\s*new\(\s*([^()]+?)\s*\)\s*,\s*&?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/g)) {
    push(goSimpleTypeName(m[1]!), goSimpleTypeName(m[2]!), m.index!, "wire.InterfaceValue");
  }

  const providers = new ProviderTypes(code);
  // fx.Annotate(provider, …fx.As(new(I))…) and <container>.Provide(provider, …dig.As(new(I))…)
  for (const [re, as, via] of [
    [/\bfx\.Annotate\(/g, "fx.As(", "fx.As"],
    [/\.Provide\(/g, "dig.As(", "dig.As"],
  ] as const) {
    for (const m of code.matchAll(re)) {
      const open = m.index! + m[0].length - 1;
      const close = matchingClose(code, open);
      if (close < 0) continue;
      const args = splitGoTopLevel(code.slice(open + 1, close));
      if (args.length < 2 || !args.some((a) => a.startsWith(as))) continue;
      // The RESULT's name/group — `fx.ParamTags` name the provider's inputs.
      const result = args.filter((a) => /^(?:fx\.ResultTags|dig\.Name|dig\.Group)\(/.test(a)).join(" ");
      if (/\bgroup:\\?"|\bdig\.Group\(/.test(result)) continue;
      const name = /\bname:\\?"([^"\\]+)\\?"/.exec(result)?.[1] ?? /\bdig\.Name\(\s*"([^"]+)"\s*\)/.exec(result)?.[1];
      const impl = providers.typeOf(args[0]!, code.indexOf(args[0]!, open));
      for (const arg of args) {
        if (!arg.startsWith(as)) continue;
        const inner = arg.slice(as.length, matchingClose(arg, as.length - 1));
        for (const iface of splitGoTopLevel(inner)) {
          const svc = /^new\(\s*([^()]+?)\s*\)$/.exec(iface);
          if (!svc) continue; // fx.Self() and the like
          push(goSimpleTypeName(svc[1]!), impl, m.index!, via, name ? { qualifier: name, keyedOnly: true } : {});
        }
      }
    }
  }
  return out;
}

/** Offset in `code` → 1-based line. */
function lineIndex(code: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** What a provider expression builds — see {@link extractGoDiBindings}. */
class ProviderTypes {
  private funcs: Map<string, number> | null = null;
  private structs: Set<string> | null = null;

  constructor(private readonly code: string) {}

  typeOf(expr: string, at: number): string | null {
    const text = expr.trim();
    if (/^func\s*\(/.test(text)) return at >= 0 ? this.built(this.code.indexOf("(", at)) : null;
    // A provider declared elsewhere (`NewRepo`, `pg.NewRepo`): name it, and
    // the linker reads its declared result.
    const foreign = /^(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)$/.exec(text);
    if (!foreign) return null;
    this.funcs ??= this.indexFuncs();
    const open = text.includes(".") ? undefined : this.funcs.get(text);
    return open === undefined ? foreign[1]! : this.built(open);
  }

  /** The type built by the func whose parameter list opens at `open`. */
  private built(open: number): string | null {
    const head = goResultTextAt(this.code, open);
    if (!head) return null;
    if (head.bodyOpen >= 0) {
      const end = matchingClose(this.code, head.bodyOpen);
      const body = end > 0 ? this.code.slice(head.bodyOpen + 1, end) : "";
      const returns = [...body.matchAll(/\breturn\b([^\n;]*)/g)];
      if (returns.length === 1) {
        const first = splitGoTopLevel(returns[0]![1]!)[0] ?? "";
        const lit = /^&?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/.exec(first) ?? /^new\(\s*([A-Za-z_][\w.]*)\s*\)$/.exec(first);
        if (lit && !GO_TYPE_KEYWORDS.has(lit[1]!)) return goSimpleTypeName(lit[1]!);
      }
    }
    const declared = goResultTypes(head.text)[0];
    if (!declared) return null;
    if (declared.startsWith("*")) return goSimpleTypeName(declared);
    this.structs ??= new Set([...this.code.matchAll(/^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+struct\b/gm)].map((m) => m[1]!));
    const name = goSimpleTypeName(declared);
    return name && this.structs.has(name) ? name : null;
  }

  /** Top-level functions of the file → offset of their parameter list. */
  private indexFuncs(): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of this.code.matchAll(/^func\s+([A-Za-z_]\w*)\s*(?:\[[^\]\n]*\]\s*)?\(/gm)) {
      if (!out.has(m[1]!)) out.set(m[1]!, m.index! + m[0].length - 1);
    }
    return out;
  }
}
