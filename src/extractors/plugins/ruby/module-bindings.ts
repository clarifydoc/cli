/**
 * The constants a Ruby file binds to an instance at its top level (`SERVICE = ClubService.new`,
 * `DEFAULT_GARAGE = Garage::Depot.new(1)`): a method of the file — and of any file that requires it — sees the
 * constant by bare name, so `SERVICE.process` is a call on the type its initializer constructs.
 *
 * Only column 0 counts: a constant inside a `class`/`module` is namespaced by it. An initializer that only
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

export function rubyModuleBindings(lines: readonly string[]): ModuleBindingInfo[] {
  const out = new Map<string, ModuleBindingInfo | null>();
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
    if (!/^[A-Z]/.test(raw)) continue;
    const m = CONSTRUCTED.exec(raw);
    if (!m) {
      // A constant bound again to anything else is no longer one type.
      const name = /^([A-Z][A-Za-z0-9_]*)\s*(?:\|\||&&)?=(?![=~>])/.exec(raw)?.[1];
      if (name) out.set(name, null);
      continue;
    }
    const [, name, type, rest] = m as unknown as [string, string, string, string];
    const known = out.get(name);
    if (NOT_INSTANCES.has(type) || !constructedWithoutChain(rest)) {
      out.set(name, null);
      continue;
    }
    if (known === null) continue;
    if (known && known.type !== type) out.set(name, null);
    else if (!known) out.set(name, { name, type, line: i + 1, exported: true });
  }
  return [...out.values()].filter((b): b is ModuleBindingInfo => b !== null);
}
