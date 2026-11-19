import { describe, expect, it } from "vitest";
import { splitTopLevel, type SplitTopLevelOptions } from "./split-top-level.js";

/** The bodies the plugins carried before they were merged, kept as the reference the options must reproduce. */
const legacy: Record<string, (text: string, sep?: string) => string[]> = {
  quotedList(text) {
    const out: string[] = [];
    let depth = 0, cur = "", quote: string | null = null;
    for (const ch of text) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if ("([<{".includes(ch)) depth++;
      else if (")]>}".includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  },
  resolver(text, sep = ",") {
    const out: string[] = [];
    let depth = 0, quote: string | null = null, cur = "";
    for (const ch of text) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; }
      else if (ch === "(" || ch === "[" || ch === "{") { depth++; cur += ch; }
      else if (ch === ")" || ch === "]" || ch === "}") { depth--; cur += ch; }
      else if (ch === sep && depth === 0) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    if (cur.trim().length > 0) out.push(cur);
    return out;
  },
  goEscaped(text) {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '"' || ch === "`") {
        let j = i + 1;
        while (j < text.length && text[j] !== ch) j += ch === '"' && text[j] === "\\" ? 2 : 1;
        cur += text.slice(i, j + 1);
        i = j;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      if (ch === ")" || ch === "}" || ch === "]") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  },
  goPlain(text) {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '"' || ch === "`") {
        const end = text.indexOf(ch, i + 1);
        cur += text.slice(i, end + 1);
        i = end < 0 ? text.length : end;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      if (ch === ")" || ch === "}" || ch === "]") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  },
  pascal(text, sep = ",") {
    const parts: string[] = [];
    let depth = 0, inQuote = false, start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "'") inQuote = !inQuote;
      else if (inQuote) continue;
      else if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === sep && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim());
  },
  parens(text) {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  },
  python(text, sep = ",") {
    const parts: string[] = [];
    let depth = 0, quote: string | null = null, start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "[" || ch === "(" || ch === "{") depth++;
      else if (ch === "]" || ch === ")" || ch === "}") depth--;
      else if (ch === sep && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(text.slice(start).trim());
    return parts.filter((p) => p.length > 0);
  },
  javascript(text, sep = ",") {
    const out: string[] = [];
    let depth = 0, quote: string | null = null, start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === "`") quote = ch;
      else if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === sep && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
    }
    out.push(text.slice(start).trim());
    return out.filter((s) => s.length > 0);
  },
  rustQuoted(text) {
    const out: string[] = [];
    let depth = 0, cur = "", quoted = false;
    for (const c of text) {
      if (c === '"') quoted = !quoted;
      if (!quoted && (c === "(" || c === "[" || c === "{")) depth++;
      if (!quoted && (c === ")" || c === "]" || c === "}")) depth--;
      if (!quoted && c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  },
  braces(text) {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      else if (text[i] === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  },
  elixir(text) {
    const out: string[] = [];
    let depth = 0, cur = "", quote = false;
    for (const ch of text) {
      if (ch === '"') quote = !quote;
      if (!quote) {
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") { if (depth === 0) break; depth--; }
        else if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  },
  csharpEscaped(s, sep = ",") {
    const parts: string[] = [];
    let depth = 0, quote = "", buf = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (quote) { buf += ch; if (ch === "\\") { buf += s[++i] ?? ""; continue; } if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
      if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
      if (ch === sep && depth === 0) { parts.push(buf); buf = ""; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    return parts;
  },
  csharpBare(text) {
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (const ch of text) {
      if (ch === "<" || ch === "(" || ch === "[") depth++;
      else if (ch === ">" || ch === ")" || ch === "]") depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  },
  aspire(s) {
    const out: string[] = [];
    let depth = 0, quote = false, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (quote) { if (c === "\\") i++; else if (c === '"') quote = false; continue; }
      if (c === '"') quote = true;
      else if (c === "(" || c === "<" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === ">" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    if (s.trim()) out.push(s.slice(start).trim());
    return out;
  },
  angles(text) {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (c === "<" || c === "(") depth++;
      else if (c === ">" || c === ")") depth--;
      else if (c === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  },
  swift(text, sep = ",") {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "<" || ch === "[" || ch === "(") depth++;
      else if (ch === ">" || ch === "]" || ch === ")") depth--;
      else if (ch === sep && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
    }
    out.push(text.slice(start).trim());
    return out;
  },
};

/** The options each legacy spelling maps to — the table the plugins' calls use. */
const spellings: Record<string, { opts: SplitTopLevelOptions; sep?: string; blankInput?: boolean }> = {
  quotedList: { opts: { brackets: "()[]<>{}", quotes: "\"'", clamp: true } },
  resolver: { opts: { quotes: "'\"`", tail: "blank" } },
  goEscaped: { opts: { quotes: '"`', escapes: '"', trim: true } },
  goPlain: { opts: { quotes: '"`', trim: true } },
  pascal: { opts: { brackets: "()[]", quotes: "'", trim: true, tail: "keep" }, sep: ";" },
  parens: { opts: { brackets: "()", quotes: "", tail: "keep" } },
  python: { opts: { quotes: "'\"", escapes: "'\"", trim: true, dropBlank: true } },
  javascript: { opts: { brackets: "<>()[]{}", quotes: "'\"`", trim: true, dropBlank: true } },
  rustQuoted: { opts: { quotes: '"' } },
  braces: { opts: { brackets: "{}", quotes: "", tail: "keep" } },
  elixir: { opts: { quotes: '"', stopAtCloser: true } },
  csharpEscaped: { opts: { brackets: "<>()[]{}", quotes: "\"'", escapes: "\"'" } },
  csharpBare: { opts: { brackets: "<>()[]", quotes: "", tail: "empty" } },
  aspire: { opts: { brackets: "()<>[]{}", quotes: '"', escapes: '"', trim: true, tail: "keep" }, blankInput: true },
  angles: { opts: { brackets: "<>()", quotes: "", tail: "keep" } },
  swift: { opts: { brackets: "<>[]()", quotes: "", trim: true, tail: "keep" } },
};

/** A seeded corpus: hand-picked shapes plus every short string over the alphabet that matters. */
function corpus(): string[] {
  const fixed = [
    "", " ", ",", "a", "a,b", "a, b ,c", "a,", "a,,b", ",a", "f(a, b), c", "Map<K, V>, int", "x[1, 2], {a, b}", '"a,b", c',
    "'a,b', c", "`a,b`, c", '"a\\",b", c', "a) , b", "a, (b", "a,)b,c", "{a,b},{c}", "a | b, c", "a;b;c", "k: v; (x; y); z",
    "a // c, d\n, b", "x => y, z", "a<b, c>, d", '"', "'", "a,\"b", "a\\", "'it''s', x",
  ];
  const alphabet = ["a", ",", ";", "(", ")", "[", "]", "{", "}", "<", ">", '"', "'", "`", "\\", " ", "|"];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const generated: string[] = [];
  for (let n = 0; n < 4000; n++) {
    let s = "";
    for (let k = Math.floor(rnd() * 10); k > 0; k--) s += alphabet[Math.floor(rnd() * alphabet.length)];
    generated.push(s);
  }
  return [...fixed, ...generated];
}

const terminated = (s: string): boolean => {
  // every quote character that occurs opens and closes (a crude but sufficient filter for the indexOf-style readers)
  for (const q of ['"', "'", "`"]) if ((s.split(q).length - 1) % 2 === 1) return false;
  return true;
};

describe("splitTopLevel options reproduce each plugin's own split", () => {
  for (const [name, { opts, sep, blankInput }] of Object.entries(spellings)) {
    it(name, () => {
      const options = { ...opts, ...(sep ? { sep } : {}) };
      const wantSep = sep;
      for (const text of corpus()) {
        // the legacy readers that find a string's end with indexOf loop or drop text when it never ends
        if (name === "goPlain" && !terminated(text)) continue;
        // a backslash before a closing quote differs only for readers without escapes, which the spelling table already separates
        // a caller whose legacy reader answered [] for a blank input guards the call itself
        const got = blankInput && !text.trim() ? [] : splitTopLevel(text, options);
        expect(got, JSON.stringify(text)).toEqual(legacy[name]!(text, wantSep));
      }
    });
  }
});

describe("splitTopLevel", () => {
  it("splits on a separator outside brackets and strings", () => {
    expect(splitTopLevel('a, f(b, c), "d,e", [1, 2]', { trim: true })).toEqual(["a", "f(b, c)", '"d,e"', "[1, 2]"]);
  });
  it("gives the empty input per the tail option", () => {
    expect(splitTopLevel("")).toEqual([]);
    expect(splitTopLevel("", { tail: "keep" })).toEqual([""]);
    expect(splitTopLevel(" ", { tail: "empty" })).toEqual([" "]);
  });
  it("ends an unterminated string at the end of the text and terminates", () => {
    expect(splitTopLevel('a, "b, c', { trim: true })).toEqual(["a", '"b, c']);
  });
  it("stops at a closer nothing opened", () => {
    expect(splitTopLevel("a, b), c", { stopAtCloser: true })).toEqual(["a", " b"]);
  });
});
