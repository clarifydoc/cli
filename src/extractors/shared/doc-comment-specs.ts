/**
 * The doc-comment shapes languages share (`LanguagePluginMeta.docComments`).
 * Leaf module: plugin metas import it, it imports nothing but types.
 */
import type { DocCommentSpec } from "../../types/language-plugin.js";

/** Decorators and annotations (`@Get()`, `@dataclass`), attributes (`[HttpGet]`, `#[derive(…)]`). */
const AT_OR_BRACKET = /^\s*(?:@[\w.]+|\[[A-Za-z][^\]]*\]|#\[)/;

/** C family: `/** … *\/` (JSDoc, Javadoc, KDoc, PHPDoc, Doxygen), `///`, `//`. */
export const C_STYLE_DOCS: DocCommentSpec = {
  line: ["///", "//"],
  block: [["/**", "*/"], ["/*", "*/"]],
  attribute: AT_OR_BRACKET,
};

/** `#` comments: Ruby, Bash, R (`#'` roxygen), Perl, Crystal, PowerShell, Nim (`##`). */
export const HASH_DOCS: DocCommentSpec = {
  line: ["#'", "##", "#"],
  attribute: /^\s*@[\w.]+/,
};

/** A docstring as the body's first statement, `#` comments above, decorators between. */
export const PYTHON_DOCS: DocCommentSpec = {
  line: ["#"],
  docstring: true,
  attribute: /^\s*@[\w.]+/,
};

/** Pascal/Delphi: `{ … }`, `(* … *)`, `///` and `//`. */
export const PASCAL_DOCS: DocCommentSpec = {
  line: ["///", "//"],
  block: [["(*", "*)"], ["{", "}"]],
  attribute: /^\s*\[[A-Za-z][^\]]*\]/,
};

/** `--` comments: SQL, Lua (`---` LDoc), Haskell (`-- |`). */
export const DASH_DOCS: DocCommentSpec = {
  line: ["---", "-- |", "--"],
  block: [["{-|", "-}"], ["{-", "-}"]],
};

/** ML family: OCaml `(** … *)`, F# `///`. */
export const ML_DOCS: DocCommentSpec = {
  line: ["///", "//"],
  block: [["(**", "*)"], ["(*", "*)"]],
  attribute: /^\s*\[<[^>]*>\]/,
};

/** Visual Basic: `'''` XML doc comments, `'` comments; `<Attribute>` lines between. */
export const VB_DOCS: DocCommentSpec = {
  line: ["'''", "'"],
  attribute: /^\s*<[A-Z][^>]*>\s*_?$/,
};
