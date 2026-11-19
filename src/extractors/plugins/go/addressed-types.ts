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

export function goAddressedTypes(lines: string[]): string[] {
  const found = new Set<string>();
  const text = code(lines);
  // Locals declared as a value of a type: `c := Club{…}`, `var c Club`, `var c = Club{…}`.
  const valueLocals = new Map<string, Set<string>>();
  for (const line of text) {
    const t = line.replace(/^\s*func\s*\([^)]*\)/, "func ");
    for (const m of t.matchAll(new RegExp(`(${IDENT})\\s*:?=\\s*(?:\\w+\\.)?(${IDENT})\\s*\\{`, "g"))) (valueLocals.get(m[1]!) ?? valueLocals.set(m[1]!, new Set()).get(m[1]!)!).add(m[2]!);
    // A parameter or a `var`: `c Club`, `var c Club`.
    for (const m of t.matchAll(new RegExp(`(?:\\bvar\\s+|[(,]\\s*)(${IDENT})\\s+(?:\\w+\\.)?([A-Z]\\w*)\\b`, "g"))) (valueLocals.get(m[1]!) ?? valueLocals.set(m[1]!, new Set()).get(m[1]!)!).add(m[2]!);
  }
  // Every type the file names in value form: composites, `var`, parameters, slices and maps of one.
  const valueTypes = new Set<string>();
  for (const line of text) {
    for (const m of line.matchAll(new RegExp(`(?:\\]|\\b)\\s*(?:\\w+\\.)?([A-Z]\\w*)\\s*\\{`, "g"))) valueTypes.add(m[1]!);
    for (const m of line.matchAll(new RegExp(`(?:\\[\\w*\\]|\\bmap\\[[^\\]]*\\]|\\b${IDENT}\\s)\\s*(?:\\w+\\.)?([A-Z]\\w*)\\b`, "g"))) valueTypes.add(m[1]!);
  }
  for (const line of text) {
    // A method's receiver declares the pointer form, it does not use it.
    const t = line.replace(/^\s*func\s*\([^)]*\)/, "func ");
    for (const m of t.matchAll(new RegExp(`(?:^|[^\\w)\\]])\\s*\\*\\s*(?:\\w+\\.)*(${IDENT})`, "g"))) found.add(m[1]!);
    for (const m of t.matchAll(new RegExp(`\\)\\s*\\*\\s*(?:\\w+\\.)*(${IDENT})`, "g"))) found.add(m[1]!);
    for (const m of t.matchAll(new RegExp(`&\\s*(?:\\w+\\.)*(${IDENT})\\s*[{\\[]`, "g"))) found.add(m[1]!);
    for (const m of t.matchAll(new RegExp(`\\bnew\\s*\\(\\s*(?:\\w+\\.)*(${IDENT})`, "g"))) found.add(m[1]!);
    // `&x`, `&x[i]`, `&x.f` of a value: its type when the file states it, else every value type the file names.
    for (const m of t.matchAll(new RegExp(`&\\s*(${IDENT})\\b(?!\\s*[{(])`, "g"))) {
      const known = valueLocals.get(m[1]!);
      for (const ty of known ?? valueTypes) found.add(ty);
    }
  }
  return [...found].sort();
}
