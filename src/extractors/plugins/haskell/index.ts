import type { RegexLangSpec } from "../shared/regex-base.js";

/** Symbols an operator is spelled with. */
const OP = "[!#$%&*+./<=>?@\\\\^|~:-]+";

/** A left operand of an infix definition: a name, `_`, a bracketed or parenthesized pattern. */
const LEFT = "(?:[a-z_][\\w']*|\\([^)]*\\)|\\[[^\\]]*\\])";
/** The rest of the equation up to its `=` (not `==`, `=>`, or the tail of another operator). */
const TO_EQUALS = "\\s*\\S[^=]*?(?<![=<>!/:|\\\\-])=(?![=>])";

/**
 * Top-level infix definitions, each capturing the defined name in group 1:
 * `a <+> b = …`, ``x `plus` y = …`` and the prefix form `(<+>) a b = …`.
 */
const INFIX_DEFINITIONS: readonly RegExp[] = [
  new RegExp(`^${LEFT}\\s*(${OP})${TO_EQUALS}`),
  new RegExp(`^${LEFT}\\s*\`([a-z_][\\w']*)\`${TO_EQUALS}`),
  new RegExp(`^\\((${OP})\\)\\s+[^=]*?(?<![=<>!/:|\\\\-])=(?![=>])`),
];

/** Operator texts that are syntax, not a definable operator. */
const NOT_AN_OPERATOR = new Set(["=", "::", "|", "->", "<-", "=>", "@", "~", "\\", ".."]);

/** The name an infix definition line defines, or null. */
function infixName(line: string): string | null {
  for (const re of INFIX_DEFINITIONS) {
    const name = re.exec(line)?.[1];
    if (name && !NOT_AN_OPERATOR.has(name)) return name;
  }
  return null;
}

/** An infix-definition function pattern: its first equation, when no signature declares the name. */
const infixPattern = (pattern: RegExp) => ({
  pattern,
  isExported: () => true,
  accept: (lines: readonly string[], i: number) => {
    const name = pattern.exec(lines[i]!)?.[1];
    return !!name && !NOT_AN_OPERATOR.has(name) && !declaredBefore(lines, i, name);
  },
});

/** Whether an earlier top-level line already declares `name` (its signature, or an earlier equation). */
function declaredBefore(lines: readonly string[], i: number, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signature = new RegExp(`^(?:${esc}|\\(${esc}\\))\\s*::`);
  for (let j = 0; j < lines.length; j++) {
    if (j === i) continue;
    const l = lines[j]!;
    if (signature.test(l)) return true;
    if (j < i && infixName(l) === name) return true;
  }
  return false;
}

/**
 * Haskell regex spec. Layout (indent) structured. Functions are captured from
 * their top-level type signature `name :: Type` (one per function, carries the
 * name); `data`/`newtype`/`class`/`instance` become the class concept. Imports
 * are `import [qualified] Module [as M] [(names)]`.
 */
export const haskellSpec: RegexLangSpec = {
  language: "haskell",
  extensions: [".hs", ".lhs"],
  indentBased: true,
  lineCommentPrefixes: ["--"],

  functionPatterns: [
    {
      // Top-level signature `parseConfig :: FilePath -> IO Config`.
      pattern: /^([a-z_][\w']*)\s*::/,
      isExported: () => true, // visibility is via the module export list
    },
    {
      // An operator's signature `(<+>) :: Score -> Score -> Score`.
      pattern: /^\(([!#$%&*+./<=>?@\\^|~:-]+)\)\s*::/,
      isExported: () => true,
    },
    // An infix definition with no signature: `a <+> b = …`, ``x `plus` y = …``,
    // `(<+>) a b = …` — its first equation only.
    ...INFIX_DEFINITIONS.map(infixPattern),
  ],

  classPatterns: [
    { pattern: /^(?:data|newtype)\s+([A-Z][\w']*)/ },
    { pattern: /^class\s+(?:[^=>]*=>\s*)?([A-Z][\w']*)/ },
  ],

  importPatterns: [
    {
      // `import qualified Data.Map as M (foo, bar)` → source Data.Map
      pattern: /^import\s+(?:qualified\s+)?([A-Z][\w'.]*)/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        const parts = m[1].split(".");
        return [parts[parts.length - 1]];
      },
    },
  ],
};
