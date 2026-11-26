/**
 * The types a Go file uses by address, as bare names. A method with a pointer receiver is in the method set of `*T`
 * only, so a type no file ever takes the address of — no `&T{…}`, `new(T)`, `*T` in a signature, field or
 * conversion, `&x` of a local declared as a `T` — cannot satisfy an interface through such a method. The reading
 * errs toward "addressed": anything that looks like a pointer form to the type counts, so a link is dropped only
 * where the code never shows one.
 */

const IDENT = "[A-Za-z_]\\w*";

/** Code with comments and string literals blanked, line by line (block comments and raw strings across lines). */
export function code(lines: readonly string[]): string[] {
  const out: string[] = [];
  let block = false;
  let raw = false;
  for (const line of lines) {
    let s = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (block) { if (c === "*" && line[i + 1] === "/") { block = false; i++; } continue; }
      if (raw) { if (c === "`") raw = false; continue; }
      if (c === "/" && line[i + 1] === "*") { block = true; i++; continue; }
      if (c === "/" && line[i + 1] === "/") break;
      if (c === "`") { raw = true; continue; }
      if (c === "'") {
        // A rune literal (`'"'`, `'\\''`) is no string.
        const m = /^'(?:\\.[^']*|[^'\\])'/.exec(line.slice(i));
        if (m) { s += "''"; i += m[0].length - 1; continue; }
      }
      if (c === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
        i = j;
        s += '""';
        continue;
      }
      s += c;
    }
    out.push(s);
  }
  return out;
}

const RECEIVER_RE = /^\s*func\s*\([^)]*\)/;
const LOCAL_COMPOSITE_RE = new RegExp(`(${IDENT})\\s*:?=\\s*(?:\\w+\\.)?(${IDENT})\\s*\\{`, "g");
const LOCAL_PARAM_RE = new RegExp(`(?:\\bvar\\s+|[(,]\\s*)(${IDENT})\\s+(?:\\w+\\.)?([A-Z]\\w*)\\b`, "g");
const VALUE_COMPOSITE_RE = /(?:\]|\b)\s*(?:\w+\.)?([A-Z]\w*)\s*\{/g;
const VALUE_DECLARED_RE = new RegExp(`(?:\\[\\w*\\]|\\bmap\\[[^\\]]*\\]|\\b${IDENT}\\s)\\s*(?:\\w+\\.)?([A-Z]\\w*)\\b`, "g");
const STAR_RE = new RegExp(`\\*\\s*(?:\\w+\\.)*(${IDENT})`, "g");
const PAREN_STAR_RE = new RegExp(`\\)\\s*\\*\\s*(?:\\w+\\.)*(${IDENT})`, "g");
const AMP_LITERAL_RE = new RegExp(`&\\s*(?:\\w+\\.)*(${IDENT})\\s*[{\\[]`, "g");
const NEW_RE = new RegExp(`\\bnew\\s*\\(\\s*(?:\\w+\\.)*(${IDENT})`, "g");
const AMP_VALUE_RE = new RegExp(`&\\s*(${IDENT})\\b(?!\\s*[{(])`, "g");

/**
 * Method sets follow the receiver kind. `FunctionInfo.pointerReceiver` marks `func (c *T)` (both front ends read it
 * from the declaration line); `FileAnalysis.addressedTypes` lists types a file uses by address — `&T{…}`, `*T`
 * outside a receiver, `new(T)`, `&x` of a local or parameter declared `T` (an `&x` it cannot type adds every value
 * type the file names). With `structuralMatch.receiverKinds` the interface map leaves a pointer-receiver method out
 * of the method set of a type no file addresses, so a value-only type implements nothing needing it and is never
 * fanned out to; an embedded type always counts as addressed. Value locals and value types are read only when an `&x`
 * of a value exists.
 */
export function goAddressedTypes(lines: string[]): string[] {
  const found = new Set<string>();
  const text = code(lines);
  // The `&x` of a value (`&x`, `&x[i]`, `&x.f`) is the one read that needs the types of locals and of value forms, so
  // a file with none reads neither, and the locals are kept only for the names an `&` takes.
  const ampNames = new Set<string>();
  for (const line of text) {
    if (!line.includes("&")) continue;
    for (const m of line.matchAll(AMP_VALUE_RE)) ampNames.add(m[1]!);
  }
  // Locals declared as a value of a type: `c := Club{…}`, `var c Club`, `var c = Club{…}`.
  const valueLocals = new Map<string, Set<string>>();
  const addLocal = (name: string, type: string): void => {
    if (!ampNames.has(name)) return;
    (valueLocals.get(name) ?? valueLocals.set(name, new Set()).get(name)!).add(type);
  };
  if (ampNames.size > 0) {
    for (const line of text) {
      const t = line.includes("func") ? line.replace(RECEIVER_RE, "func ") : line;
      if (t.includes("{") && t.includes("=")) for (const m of t.matchAll(LOCAL_COMPOSITE_RE)) addLocal(m[1]!, m[2]!);
      // A parameter or a `var`: `c Club`, `var c Club`.
      for (const m of t.matchAll(LOCAL_PARAM_RE)) addLocal(m[1]!, m[2]!);
    }
  }
  // Every type the file names in value form: composites, `var`, parameters, slices and maps of one. Read once, when
  // an `&x` names a local the file does not declare.
  let valueTypes: Set<string> | undefined;
  const valueTypesOf = (): Set<string> => {
    if (valueTypes) return valueTypes;
    valueTypes = new Set<string>();
    for (const line of text) {
      if (line.includes("{")) for (const m of line.matchAll(VALUE_COMPOSITE_RE)) valueTypes.add(m[1]!);
      for (const m of line.matchAll(VALUE_DECLARED_RE)) valueTypes.add(m[1]!);
    }
    return valueTypes;
  };
  for (const line of text) {
    // A method's receiver declares the pointer form, it does not use it.
    const t = line.includes("func") ? line.replace(RECEIVER_RE, "func ") : line;
    // A `*` that does not follow a value (an identifier, `)` or `]`) is a pointer type. The `*` is found first and its
    // left side judged once, so a long whitespace run is no start position of its own.
    if (t.includes("*")) {
      for (const m of t.matchAll(STAR_RE)) {
        if (m.index > 0 && /[\w)\]]/.test(t[m.index - 1]!)) continue;
        found.add(m[1]!);
      }
      for (const m of t.matchAll(PAREN_STAR_RE)) found.add(m[1]!);
    }
    if (t.includes("&")) {
      for (const m of t.matchAll(AMP_LITERAL_RE)) found.add(m[1]!);
      // `&x`, `&x[i]`, `&x.f` of a value: its type when the file states it, else every value type the file names.
      for (const m of t.matchAll(AMP_VALUE_RE)) {
        const known = valueLocals.get(m[1]!);
        for (const ty of known ?? valueTypesOf()) found.add(ty);
      }
    }
    if (t.includes("new")) for (const m of t.matchAll(NEW_RE)) found.add(m[1]!);
  }
  return [...found].sort();
}
