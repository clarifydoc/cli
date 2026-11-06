/**
 * The doc-comment shapes languages share (`LanguagePluginManifest.docComments`).
 * Leaf module: plugin manifests import it, it imports nothing but types.
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

/** SQL: `--` lines and `/* … *\/` blocks above a statement. */
export const SQL_DOCS: DocCommentSpec = {
  line: ["---", "--"],
  block: [["/**", "*/"], ["/*", "*/"]],
};

/** PowerShell: `#` lines and `<# … #>` comment-based help. */
export const POWERSHELL_DOCS: DocCommentSpec = {
  line: ["#"],
  block: [["<#", "#>"]],
};

/** Lisp family: `;;;` and `;;` (and `;`) comment lines above a form. */
export const SEMICOLON_DOCS: DocCommentSpec = {
  line: [";;;", ";;", ";"],
};

/** Erlang: `%%%` and `%%` (and `%`) comment lines above a function. */
export const PERCENT_DOCS: DocCommentSpec = {
  line: ["%%%", "%%", "%"],
};

/**
 * Elixir: `#` comments, and the `@doc """ … """` / `@moduledoc """ … """` heredoc above a function or module (`@spec`,
 * `@impl true` between it and the `def` are attributes).
 */
export const ELIXIR_DOCS: DocCommentSpec = {
  line: ["##", "#"],
  block: [['"""', '"""']],
  blockLead: /^\s*@(?:doc|moduledoc|typedoc)\s*(?:~[sS])?\s*$/,
  moduleDocInside: true,
  attribute: /^\s*@[\w.]+/,
};

/** Perl: `#` comments, and POD (`=head2 name` … `=cut`) above a sub or package. */
export const PERL_DOCS: DocCommentSpec = {
  line: ["#"],
  pod: true,
  attribute: /^\s*:\s*\w+/,
};

/** `!` comments (Fortran free form; `!>` and `!!` Doxygen/FORD). */
export const BANG_DOCS: DocCommentSpec = {
  line: ["!>", "!!", "!"],
};

/** Batch: `::` and `REM` comment lines (`@REM` too), in any case. */
export const BATCH_DOCS: DocCommentSpec = {
  line: ["::", "@rem ", "rem "],
  caseInsensitive: true,
};
