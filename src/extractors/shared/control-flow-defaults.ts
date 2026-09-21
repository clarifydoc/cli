import type {
  ControlFlowField,
  ControlFlowRole,
  LanguageControlFlowSpec,
} from "../../types/language-plugin.js";

/**
 * Default control-flow tables — the C-family statement vocabulary, which most
 * tree-sitter grammars spell the same way. A leaf module (not the registry) so
 * `core/control-flow` can use it without any plugin being loaded; the
 * javascript plugin reuses it as its own spec, exactly as it does with
 * `DEFAULT_COMPLEXITY`, so the default and the TS/JS tables can never drift.
 *
 * Node types listed here that a given grammar does not have simply never
 * match, so one table can name both dialects of a construct (TypeScript's
 * `switch_case` and C#'s `switch_section`) without either language paying for
 * the other's spelling.
 */
const ROLES: ReadonlyArray<readonly [string, ControlFlowRole]> = [
  // Statement sequences.
  ["statement_block", "block"],
  ["block", "block"],

  // Two-way branches. `else_clause` is a transparent wrapper: TypeScript hangs
  // the else branch off one, C# points `alternative` straight at the statement.
  ["if_statement", "branch"],
  ["else_clause", "wrapper"],

  // Loops. `for_in_statement` is TypeScript's `for…of` / `for…in`.
  ["while_statement", "loop"],
  ["for_statement", "loop"],
  ["for_in_statement", "loop"],
  ["for_of_statement", "loop"],
  ["foreach_statement", "loop"],
  ["do_statement", "post-test-loop"],

  // Multi-way branches.
  ["switch_statement", "switch"],
  ["switch_body", "block"],
  ["switch_case", "case"],
  ["switch_default", "case"],
  ["switch_section", "case"],
  ["case_pattern", "case-label"],
  ["constant_pattern", "case-label"],
  ["default_switch_label", "case-label"],
  ["case_switch_label", "case-label"],

  // Exceptions.
  ["try_statement", "try"],
  ["catch_clause", "catch"],
  ["finally_clause", "finally"],

  // Jumps.
  ["return_statement", "return"],
  ["throw_statement", "throw"],
  ["break_statement", "break"],
  ["continue_statement", "continue"],
  ["labeled_statement", "label"],

  // Unconditional wrappers — entered exactly once, no branch of their own.
  ["using_statement", "wrapper"],
  ["lock_statement", "wrapper"],
  ["checked_statement", "wrapper"],
  ["unsafe_statement", "wrapper"],

  // Not statements. A comment sits in a block's named children exactly where a
  // statement does, and drawing one as a box is how a diagram fills with prose.
  ["comment", "ignore"],
  ["line_comment", "ignore"],
  ["block_comment", "ignore"],

  // Nested functions: the CFG of a function stops at the boundary of another.
  ["function_declaration", "nested-function"],
  ["function_expression", "nested-function"],
  ["generator_function", "nested-function"],
  ["generator_function_declaration", "nested-function"],
  ["arrow_function", "nested-function"],
  ["method_definition", "nested-function"],
  ["local_function_statement", "nested-function"],
  ["lambda_expression", "nested-function"],
  ["anonymous_method_expression", "nested-function"],
];

/**
 * Field-name candidates per part, tried in order. Listing both dialects here
 * rather than per language keeps most plugins down to a `roles` table: C#
 * spells a `for` loop's third clause `update` and TypeScript spells it
 * `increment`, and neither grammar has the other's field, so trying both is
 * free.
 */
export const DEFAULT_CONTROL_FLOW_FIELDS: Readonly<
  Record<ControlFlowField, readonly string[]>
> = {
  condition: ["condition"],
  // PHP names an `if`'s then-branch `body`; Pascal names it `then`.
  consequence: ["consequence", "then", "body"],
  alternative: ["alternative", "else"],
  body: ["body"],
  update: ["increment", "update"],
  initializer: ["initializer", "initialiser", "initialize", "init", "start"],
  // Python's `match` calls the value it tests `subject`; PHP and Java call a
  // `switch`'s `condition`.
  value: ["value", "subject", "condition"],
  label: ["label"],
  finalizer: ["finalizer", "finally"],
};

/**
 * Arm labels that mean "everything else". Spelled as a label rather than as
 * the absence of one by Java (`default:`), Python (`case _:`), Kotlin and
 * Pascal (`else`), so the text is what identifies them.
 */
export const DEFAULT_WILDCARD_LABELS: readonly string[] = ["default", "default:", "_", "else"];

export const DEFAULT_CONTROL_FLOW: LanguageControlFlowSpec = {
  roles: new Map(ROLES),
};

/**
 * A spec built from the C-family defaults plus a language's own node types —
 * how a plugin declares only what its grammar spells differently.
 */
export function extendControlFlow(
  extra: ReadonlyArray<readonly [string, ControlFlowRole]>,
  options: Omit<LanguageControlFlowSpec, "roles"> = {},
): LanguageControlFlowSpec {
  const roles = new Map(ROLES);
  for (const [type, role] of extra) roles.set(type, role);
  return { roles, ...options };
}
