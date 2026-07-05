import type { RegexLangSpec } from "../shared/regex-base.js";
import type { ClassInfo } from "../../../types/analysis.js";

/**
 * Erlang regex spec. Erlang has no `def` keyword and no classes — a file is a
 * module (`-module(name).`). Function clause heads sit at column 0 (`foo(X) ->`);
 * module attributes start with `-`, macros with `?`, and call expressions are
 * indented inside bodies, so a column-0 lowercase-atom-`(` is a function head.
 * Bodies are conventionally indented, so the indent block style approximates
 * clause extents.
 */
export const erlangSpec: RegexLangSpec = {
  language: "erlang",
  extensions: [".erl", ".hrl"],
  indentBased: true,
  lineCommentPrefixes: ["%"],

  functionPatterns: [
    {
      pattern: /^([a-z][\w@]*)\s*\(/,
      isExported: () => true, // visibility is declared via `-export`, not per-clause
    },
  ],

  classPatterns: [],

  // A file is a module — model `-module(name)` as one file-scoped class (like
  // Perl packages), with all functions as its methods and `-behaviour(B)` OTP
  // behaviours as `implements` edges (gen_server etc. are interface-like).
  extractClasses: (lines, fns): ClassInfo[] => {
    let name: string | null = null;
    let line = 1;
    const implementsList: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const mm = lines[i].match(/^-module\s*\(\s*([a-z][\w]*)/);
      if (mm) { name = mm[1]; line = i + 1; }
      const bm = lines[i].match(/^-behaviou?r\s*\(\s*([a-z][\w]*)/);
      if (bm) implementsList.push(bm[1]);
    }
    if (!name) return [];
    return [{
      name, extends: null, implements: implementsList, decorators: [],
      methods: fns, properties: [], isExported: true, line, endLine: lines.length,
    }];
  },

  importPatterns: [
    { pattern: /^-import\s*\(\s*([a-z][\w]*)/, getSource: (m) => m[1] },
    { pattern: /^-include(?:_lib)?\s*\(\s*"([^"]+)"/, getSource: (m) => m[1] },
  ],

  callPatterns: [
    {
      // Cross-module call: `gen_server:call(...)`, `lists:map(...)`, `epgsql:equery(...)`.
      pattern: /\b([a-z][\w]*)\s*:\s*([a-z][\w]*)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}:${m[2]}`, leafName: m[2] }),
    },
  ],
};
