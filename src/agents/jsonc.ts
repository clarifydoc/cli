/**
 * A small editor for JSONC config files (comments, trailing commas): the
 * `opencode.jsonc`, `kilo.jsonc`, `.vscode/mcp.json` and Zed settings people
 * write by hand. Round-tripping one through JSON.parse/stringify would drop
 * every comment, so the file is edited as text: a same-length mask (comments
 * and trailing commas blanked) is read for the structure — every offset in it
 * is valid in the original — and only the one member being set is spliced in
 * or replaced. The result is read back and must equal the original document
 * with exactly that member changed; otherwise the edit is refused (null) and
 * the caller leaves the file alone.
 */

/** The text with comments and trailing commas blanked to spaces (newlines kept), strings untouched. */
export function maskJsonc(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
      continue;
    }
    i++;
  }
  // Trailing commas: a comma whose next token closes the object or array.
  const masked = out.join("");
  for (let j = 0; j < masked.length; j++) {
    if (masked[j] === '"') {
      j = stringEnd(masked, j) - 1;
      continue;
    }
    if (masked[j] !== ",") continue;
    const next = skipWs(masked, j + 1);
    if (masked[next] === "}" || masked[next] === "]") out[j] = " ";
  }
  return out.join("");
}

/** The document a JSONC text holds, or undefined when it holds none. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(maskJsonc(text));
  } catch {
    return undefined;
  }
}

/**
 * `text` with `doc[top][name] = value` — the member replaced where it is, or
 * added after the object's last member, the object created when `top` is
 * missing — keeping every other byte. Null when the text is not a JSONC
 * object, `top` holds something other than an object, or the edit does not
 * read back as exactly that change.
 */
export function upsertJsoncMember(text: string, top: string, name: string, value: unknown): string | null {
  const masked = maskJsonc(text);
  let doc: unknown;
  try {
    doc = JSON.parse(masked);
  } catch {
    return null;
  }
  if (!isObject(doc)) return null;
  const rootOpen = skipWs(masked, 0);
  const root = membersOf(masked, rootOpen);
  if (!root) return null;
  const topMember = root.members.find((m) => m.key === top);
  let out: string;
  if (topMember) {
    if (!isObject(doc[top])) return null;
    const inner = membersOf(masked, topMember.valueStart);
    if (!inner) return null;
    const mine = inner.members.find((m) => m.key === name);
    out = mine
      ? text.slice(0, mine.valueStart) + render(value, lineIndent(text, mine.keyStart)) + text.slice(mine.valueEnd)
      : insertMember(text, masked, topMember.valueStart, inner, name, value);
  } else {
    out = insertMember(text, masked, rootOpen, root, top, { [name]: value });
  }
  const expected = { ...doc, [top]: { ...((doc[top] as Record<string, unknown> | undefined) ?? {}), [name]: value } };
  return sameJson(parseJsonc(out), expected) ? out : null;
}

interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/** The members of the object opening at `open` in the masked text, and where it closes. */
function membersOf(s: string, open: number): { members: Member[]; close: number } | null {
  if (s[open] !== "{") return null;
  const members: Member[] = [];
  let i = skipWs(s, open + 1);
  while (i < s.length && s[i] !== "}") {
    if (s[i] !== '"') return null;
    const keyEnd = stringEnd(s, i);
    const key = JSON.parse(s.slice(i, keyEnd)) as string;
    let j = skipWs(s, keyEnd);
    if (s[j] !== ":") return null;
    const valueStart = skipWs(s, j + 1);
    const valueEnd = valueEndOf(s, valueStart);
    members.push({ key, keyStart: i, valueStart, valueEnd });
    j = skipWs(s, valueEnd);
    if (s[j] === ",") j = skipWs(s, j + 1);
    i = j;
  }
  return i < s.length ? { members, close: i } : null;
}

/** Add `"key": value` as the object's last member, matching the indentation of the members around it. */
function insertMember(text: string, masked: string, open: number, obj: { members: Member[]; close: number }, key: string, value: unknown): string {
  const last = obj.members[obj.members.length - 1];
  if (!last) {
    const outer = lineIndent(text, open);
    const indent = `${outer}  `;
    const member = `"${escapeKey(key)}": ${render(value, indent)}`;
    // An empty object, comments inside it kept after the new member.
    return text.slice(open + 1, obj.close).trim() === ""
      ? `${text.slice(0, open + 1)}\n${indent}${member}\n${outer}${text.slice(obj.close)}`
      : `${text.slice(0, open + 1)}\n${indent}${member}${text.slice(open + 1)}`;
  }
  const indent = lineIndent(text, last.keyStart);
  // A trailing comma after the last member stays a trailing comma after the new one.
  let after = last.valueEnd;
  while (after < obj.close && text[after] !== "," && /\s/.test(masked[after]!)) after++;
  const trailing = text[after] === ",";
  const from = trailing ? after + 1 : last.valueEnd;
  const eol = masked.indexOf("\n", from);
  const lineEnd = eol < 0 ? masked.length : eol;
  const member = `"${escapeKey(key)}": ${render(value, indent)}`;
  // On its own line after the last member's line (a comment there stays with it), unless the object is on one line.
  if (lineEnd <= obj.close && masked.slice(from, lineEnd).trim() === "") {
    return `${text.slice(0, last.valueEnd)}${trailing ? "" : ","}${text.slice(last.valueEnd, lineEnd)}\n${indent}${member}${trailing ? "," : ""}${text.slice(lineEnd)}`;
  }
  return `${text.slice(0, last.valueEnd)}, ${member}${text.slice(last.valueEnd)}`;
}

const render = (value: unknown, indent: string) => JSON.stringify(value, null, 2).split("\n").join(`\n${indent}`);
const escapeKey = (key: string) => JSON.stringify(key).slice(1, -1);

/** The whitespace the line holding `at` starts with. */
function lineIndent(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, at))![0];
}

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  return i;
}

/** The index just past the string opening at `i`. */
function stringEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === '"') return j + 1;
  }
  return s.length;
}

/** The index just past the value starting at `i` (masked text: no comments). */
function valueEndOf(s: string, i: number): number {
  if (s[i] === '"') return stringEnd(s, i);
  if (s[i] === "{" || s[i] === "[") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '"') j = stringEnd(s, j) - 1;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) return j + 1;
      }
    }
    return s.length;
  }
  let j = i;
  while (j < s.length && !/[\s,}\]]/.test(s[j]!)) j++;
  return j;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep equality of two JSON values, member order ignored. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameJson(a[k], b[k]));
}
