/**
 * The constants a Ruby file binds to an instance at its top level (`SERVICE = ClubService.new`,
 * `DEFAULT_GARAGE = Garage::Depot.new(1)`): a method of the file — and of any file that requires it — sees the
 * constant by bare name, so `SERVICE.process` is a call on the type its initializer constructs.
 *
 * A constant at column 0 is the file's; one inside `module X` (however nested, only modules) is `X::NAME` — read
 * from elsewhere by that name, and by its bare name inside the module's body (`lexical`). One inside a `class` is
 * the class's own and is left out. An initializer that only
 * calls (`Foo.build`, `Foo.new.run`) states no type, and `Struct.new`/`Class.new`/`Module.new`/`Data.define` make a
 * class, not an instance. A constant assigned two different types decides nothing.
 */
import type { ModuleBindingInfo } from "../../../types/analysis.js";

/** `NAME = [::]Foo[::Bar].new` — then what follows `.new`, checked by `constructedWithoutChain`. */
const CONSTRUCTED = /^([A-Z][A-Za-z0-9_]*)\s*=\s*((?:::)?[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\.new\b(.*)$/;

/** Constructors of classes and modules, never of an instance of a project class. */
const NOT_INSTANCES = new Set(["Struct", "Class", "Module", "Data", "Object", "BasicObject"]);

/** What follows `.new`: nothing, a call's own parenthesised arguments, or parenless arguments — never a further call on the result. */
function constructedWithoutChain(rest: string): boolean {
  const code = rest.replace(/\s+#.*$/, "").trim();
  if (code === "" || code === "do" || /^do\s*\|/.test(code) || code.startsWith("{")) return true;
  if (code.startsWith("(")) {
    let depth = 0;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return /^\s*(?:do\b.*|\{.*)?$/.test(code.slice(i + 1));
    }
    return false;
  }
  // `Foo.new a, b` — arguments; a `.`/`&.` straight after `.new` is a chain, `?`/`!` a different method.
  return /^\s/.test(rest) && !/^[.&?!:=]/.test(code);
}

/** `module League` / `class Club` / `class << self` opening a body — what a constant below it is namespaced by. */
const OPENER = /^(\s*)(module|class)\s+(?:<<\s*\w+|(?:::)?([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*))/;

interface Body {
  indent: number;
  module: boolean;
  name: string;
  line: number;
}

export function rubyModuleBindings(lines: readonly string[]): ModuleBindingInfo[] {
  const out = new Map<string, ModuleBindingInfo | null>();
  const stack: Body[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (inBlockComment) {
      if (/^=end\b/.test(raw)) inBlockComment = false;
      continue;
    }
    if (/^=begin\b/.test(raw)) {
      inBlockComment = true;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const opener = OPENER.exec(raw);
    if (opener) {
      // `module A; end` / `class B; end` on one line opens nothing.
      if (!/(?:;|\s)end\s*(?:#.*)?$/.test(raw)) {
        stack.push({ indent, module: opener[2] === "module", name: opener[3] ?? "", line: i + 1 });
      }
      continue;
    }
    if (stack.length > 0 && /^\s*end\b/.test(raw)) {
      const top = stack[stack.length - 1]!;
      if (top.indent === indent) {
        stack.pop();
        // Close the span of the bindings this body held.
        for (const b of out.values()) if (b?.lexical && b.lexical.endLine === 0 && b.lexical.line === top.line) b.lexical.endLine = i + 1;
      }
      continue;
    }
    // Column 0 outside any body, or anywhere in a body nested only in modules: a class's constants are its own.
    const nested = stack.length > 0;
    if (nested ? !stack.every((b) => b.module && b.name) : indent !== 0) continue;
    const code = raw.slice(indent);
    if (!/^[A-Z]/.test(code)) continue;
    const prefix = stack.map((b) => b.name).join("::");
    const qualify = (n: string) => (prefix ? `${prefix}::${n}` : n);
    const m = CONSTRUCTED.exec(code);
    if (!m) {
      // A constant bound again to anything else is no longer one type.
      const name = /^([A-Z][A-Za-z0-9_]*)\s*(?:\|\||&&)?=(?![=~>])/.exec(code)?.[1];
      if (name) out.set(qualify(name), null);
      continue;
    }
    const [, bare, type, rest] = m as unknown as [string, string, string, string];
    const name = qualify(bare);
    const known = out.get(name);
    if (NOT_INSTANCES.has(type) || !constructedWithoutChain(rest)) {
      out.set(name, null);
      continue;
    }
    if (known === null) continue;
    if (known && known.type !== type) out.set(name, null);
    else if (!known) {
      const binding: ModuleBindingInfo = { name, type, line: i + 1, exported: true };
      // Inside its module(s) the bare name stands for it: the span of the innermost body.
      if (nested) binding.lexical = { name: bare, line: stack[stack.length - 1]!.line, endLine: 0 };
      out.set(name, binding);
    }
  }
  const result = [...out.values()].filter((b): b is ModuleBindingInfo => b !== null);
  for (const b of result) if (b.lexical && b.lexical.endLine === 0) b.lexical.endLine = lines.length;
  return result;
}
