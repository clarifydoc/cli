import type { LanguageComplexitySpec } from "../../types/language-plugin.js";

/**
 * Default cyclomatic-complexity tables for languages that haven't declared
 * their own — C-family branch/operator node names, which most grammars share.
 * A leaf module (not the registry) so `core/complexity-analyzer` can use it
 * without any plugin being loaded; the javascript plugin reuses it as its own
 * spec so the default and the TS/JS tables can never drift.
 */
export const DEFAULT_COMPLEXITY: LanguageComplexitySpec = {
  branchNodes: new Set([
    "if_statement", "while_statement", "for_statement", "for_in_statement",
    "switch_case", "catch_clause", "ternary_expression",
  ]),
  logicalOps: new Set(["&&", "||", "??"]),
  // Callbacks and nested functions deepen nesting for the cognitive metric.
  nestingNodes: new Set([
    "arrow_function", "function_expression", "function_declaration",
    "generator_function", "generator_function_declaration", "method_definition",
  ]),
};

/**
 * The regex path's complexity vocabulary (core/complexity-regex.ts): the
 * C-family keywords plus the script languages' `elif`/`elsif`/`unless`/
 * `until`/`when`/`rescue` spellings, the logical operators, and the block
 * closers that repeat an opener's keyword (VB `End If`, Fortran `END DO`),
 * which open nothing. A plugin overrides it with `RegexLangSpec.complexity`.
 */
export const REGEX_COMPLEXITY_DEFAULT = {
  branches:
    /\b(?:if|elif|elsif|elseif|for|foreach|while|until|unless|case|when|match|catch|rescue|except|guard|cond|loop|select)\b/g,
  logicalOps: /&&|\|\||\b(?:and|or|andalso|orelse)\b/g,
  closers: /\bend\s+(?:if|do|select|while|for|case|match|loop|try|with)\b/gi,
};
