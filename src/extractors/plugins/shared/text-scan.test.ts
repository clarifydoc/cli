import { describe, expect, it } from "vitest";
import { blankStringAwareComments, matchingBracket } from "./text-scan.js";

// The private copies the shared helpers replaced, kept here as the reference they are held equal to.
function legacyKeepStrings(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      for (; j < text.length && text[j] !== ch; j++) if (text[j] === "\\") j++;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop - 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else out += ch;
  }
  return out;
}

const legacyCSharp = (s: string): string =>
  s.replace(/"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => (c.startsWith('"') ? c : c.replace(/[^\n]/g, " ")));

const legacyThrift = (text: string): string =>
  text.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g, (m) =>
    m[0] === '"' || m[0] === "'" ? m[0] + " ".repeat(m.length - 2) + m[0] : m.replace(/[^\n]/g, " "),
  );

function legacyBlankAll(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const to = end < 0 ? text.length : end;
      blank(i, to);
      i = to;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const to = end < 0 ? text.length : end + 2;
      blank(i, to);
      i = to - 1;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let k = i + 1;
      while (k < text.length && text[k] !== ch) k += text[k] === "\\" ? 2 : 1;
      blank(i + 1, k);
      i = k;
    }
  }
  return out.join("");
}

function legacyBlankScript(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") (out += " "), i++;
      i--;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, " ") + (j < src.length ? c : "");
      i = j;
    } else out += c;
  }
  return out;
}

function legacyMixed(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function legacyMixedStrings(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
    } else if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

function legacyParenQuoted(s: string, open: number): number {
  let depth = 0;
  let quote = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function legacyBalancedSlice(text: string, open: number, left: string, right: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === left || c === "(" || c === "{" || c === "[") depth++;
    else if (c === right || c === ")" || c === "}" || c === "]") {
      if (--depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

const SAMPLES = [
  "",
  'const url = "http://car.example/garage"; // trailing\nconst b = 1; /* block\n over lines */ end',
  "a = 'it\\'s'; `tpl ${x} // not\n a comment`; // c",
  'x = "unterminated\nnext // comment\nlast "ok" /* open',
  "# hash line\nname \"a # b\" 'c // d'\n/* x */ tail\\",
  'say("a\\\nb"); "lone',
  "open /* never closed\nstill text",
  "fn(a, [b, {c: (d)}], 'x)') + `(`",
  "((( \"))\" ))",
];

function fuzz(count: number, alphabet: string[], length: number): string[] {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: count }, () => Array.from({ length: length }, () => alphabet[Math.floor(rnd() * alphabet.length)]!).join(""));
}

const ALPHABET = ["a", " ", "\n", "/", "*", "\\", '"', "'", "`", "#", "(", ")", "[", "]", "{", "}", "x"];
const ALL = [...SAMPLES, ...fuzz(4000, ALPHABET, 24), ...fuzz(1500, ALPHABET, 80)];

describe("blankStringAwareComments", () => {
  it("keeps strings, any quote, like the render-mode reader", () => {
    for (const t of ALL) expect(blankStringAwareComments(t)).toBe(legacyKeepStrings(t));
  });
  it("matches the C# reader: double quotes on one line, an unclosed block stays text", () => {
    const opts = { quotes: '"', stringsEndAtLine: true, unclosedBlockIsText: true } as const;
    for (const t of ALL) expect(blankStringAwareComments(t, opts)).toBe(legacyCSharp(t));
  });
  it("matches the Thrift reader: strings emptied, `#` comments", () => {
    const opts = { quotes: "\"'", strings: "blank", stringsEndAtLine: true, unclosedBlockIsText: true, lineComments: ["//", "#"] } as const;
    for (const t of ALL) expect(blankStringAwareComments(t, opts)).toBe(legacyThrift(t));
  });
  it("matches the script readers that empty every string", () => {
    for (const t of ALL) {
      expect(blankStringAwareComments(t, { strings: "blank" })).toBe(legacyBlankAll(t));
      expect(blankStringAwareComments(t, { strings: "blank" })).toBe(legacyBlankScript(t));
    }
  });
});

describe("matchingBracket", () => {
  const opens = (t: string) => [...t.matchAll(/[([{"'`]/g)].map((m) => m.index!).concat(0);
  it("counts every bracket kind in one depth", () => {
    for (const t of ALL) for (const o of opens(t)) expect(matchingBracket(t, o)).toBe(legacyMixed(t, o));
  });
  it("skips strings when told the quotes", () => {
    for (const t of ALL)
      for (const o of opens(t)) {
        expect(matchingBracket(t, o, { quotes: "\"'`" })).toBe(legacyMixedStrings(t, o));
        const slice = legacyBalancedSlice(t, o, "[", "]");
        const end = matchingBracket(t, o, { quotes: "\"'`" });
        // The slice reader tracks a quote as state from the first character; it agrees wherever the opener is no quote.
        if (!/["'`]/.test(t[o] ?? "")) expect(end < 0 ? null : t.slice(o + 1, end)).toBe(slice);
      }
  });
  it("counts one pair and skips double-quoted strings, like the Aspire reader", () => {
    for (const t of ALL) for (const o of opens(t)) expect(matchingBracket(t, o, { pair: "()", quotes: '"' })).toBe(legacyParenQuoted(t, o));
  });
});
