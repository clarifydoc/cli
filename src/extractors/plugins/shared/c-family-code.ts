import { braceCodeHooks, type BraceCodeHooks, type BraceLexicon } from "./brace-code.js";

/** C's literal forms: strings (a trailing `\` continues one onto the next line) and character literals. */
const C_LEXICON: BraceLexicon = {
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/" },
  strings: [{ open: '"', close: '"', escapes: true, multiline: false }],
  charLiterals: true,
};

const RAW_STRING = /(?:u8|[uUL])?R"([^()\\\s"]{0,16})\(/y;

/** C++ adds raw strings, `R"sql( … )sql"`, which may span lines and hold anything. */
const CPP_LEXICON: BraceLexicon = {
  ...C_LEXICON,
  rawString: (text, i) => {
    const c = text[i];
    if (c !== "R" && c !== "u" && c !== "U" && c !== "L") return -1;
    RAW_STRING.lastIndex = i;
    const m = RAW_STRING.exec(text);
    if (!m) return -1;
    const close = text.indexOf(`)${m[1]}"`, i + m[0].length);
    return close < 0 ? text.length : close + m[1]!.length + 2;
  },
};

/** The code-reading hooks of the C and C++ specs (see brace-code.ts). */
export const C_CODE: BraceCodeHooks = braceCodeHooks(C_LEXICON);
export const CPP_CODE: BraceCodeHooks = braceCodeHooks(CPP_LEXICON);

/** What may follow a C/C++ parameter list before the body: qualifiers, an exception spec, a trailing return type. */
const SIGNATURE_TAIL = /^(?:\s|const\b|volatile\b|noexcept\b\s*(?:\([^)]*\))?|throw\s*\([^)]*\)|override\b|final\b|mutable\b|&&?|->\s*[\w:<>,*&\s]+?(?=\s*[{:]|$)|[A-Z][A-Z0-9_]*\b(?:\([^)]*\))?)*/;

/**
 * Whether the parameter list opened on line `i` closes, within a few lines,
 * into a body (`{`, a `:` member-init list) rather than `;` — a definition, not
 * a prototype or a call. Read over `code` (comments blanked), so a `{` in a
 * trailing comment is no body.
 */
export function bodyFollowsSignature(code: readonly string[], i: number): boolean {
  const text = code.slice(i, i + 12).join("\n");
  const open = text.indexOf("(");
  if (open < 0) return false;
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === "(") depth++;
    else if (text[k] === ")" && --depth === 0) {
      const rest = text.slice(k + 1).replace(SIGNATURE_TAIL, "");
      return rest.startsWith("{") || (rest.startsWith(":") && !rest.startsWith("::"));
    }
  }
  return false;
}

/**
 * A function pattern's `accept`: the line starts in code, a body follows its
 * parameter list (read with strings and comments blanked, so `FAIL("x: y")` is
 * no definition), and it does not continue an expression or list — a line
 * after one ending in `,` is a member-initializer, parameter or enumerator, as
 * is a line opening with `:` or `,`.
 */
export function definitionAt(hooks: BraceCodeHooks): (lines: readonly string[], i: number) => boolean {
  return (lines, i) => {
    if (!hooks.startsInCode(lines, i)) return false;
    const code = hooks.codeLines(lines);
    if (/^\s*[:,]/.test(code[i] ?? "")) return false;
    for (let k = i - 1; k >= 0 && k >= i - 20; k--) {
      const prev = (code[k] ?? "").trim();
      if (!prev) continue;
      if (/(?:[,(=?+]|&&|\|\||\breturn)$/.test(prev)) return false;
      break;
    }
    return bodyFollowsSignature(code, i);
  };
}
