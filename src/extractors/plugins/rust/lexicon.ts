import type { BraceLexicon } from "../shared/brace-code.js";

const RAW_STRING = /(?:b|c)?r(#*)"/y;

/** Rust's literal forms: strings that may span lines, `r#"…"#` raw strings, character literals (a lifetime `'a` is code). */
export const RUST_LEXICON: BraceLexicon = {
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/", nests: true },
  strings: [{ open: '"', close: '"', escapes: true, multiline: true }],
  rawString: (text, i) => {
    const c = text[i];
    if (c !== "r" && c !== "b" && c !== "c") return -1;
    RAW_STRING.lastIndex = i;
    const m = RAW_STRING.exec(text);
    if (!m) return -1;
    const close = text.indexOf(`"${m[1]}`, i + m[0].length);
    return close < 0 ? text.length : close + 1 + m[1]!.length;
  },
  charLiterals: true,
};
