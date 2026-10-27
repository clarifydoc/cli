/*
 * C keywords by token type, for the two passes' tests: a token's text is built from the character stream on every
 * read, so the hot paths compare types, looked up once here by lexing each keyword.
 */
import { CharStream } from "antlr4ng";
import { CLexer } from "./CLexer.js";

/**
 * The token types `texts` lex to. The lexer is asked rather than its literal names: a rule with several spellings
 * (`Inline : 'inline' | '__inline__' | '__inline'`) has none.
 */
function typesOf(texts: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const text of texts) {
    const type = new CLexer(CharStream.fromString(text)).nextToken().type;
    if (type !== CLexer.Identifier) out.add(type);
  }
  return out;
}

/** Keywords that start or continue declaration specifiers: types, qualifiers, storage classes, function specifiers. */
export const SPECIFIER_KEYWORDS = typesOf([
  "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "_Bool", "bool", "_Complex",
  "_Imaginary", "_BitInt", "__int128", "struct", "union", "enum", "typeof", "__typeof__", "__typeof", "const",
  "volatile", "__volatile__", "restrict", "__restrict", "__restrict__", "_Atomic", "static", "extern", "auto",
  "register", "typedef", "inline", "__inline", "__inline__", "_Noreturn", "_Thread_local", "thread_local", "__thread",
  "_Alignas", "alignas", "__attribute__", "__extension__", "__declspec", "__stdcall", "__cdecl", "constexpr",
]);

/** Keywords that are a type by themselves (`int`, `struct`), as opposed to a qualifier or storage class. */
export const TYPE_KEYWORDS = typesOf([
  "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "_Bool", "bool", "_Complex",
  "_BitInt", "__int128", "struct", "union", "enum",
]);

/** Keywords a declaration's specifiers may start with besides a type: storage classes and qualifiers. */
export const LEADING_KEYWORDS = typesOf([
  "static", "extern", "const", "volatile", "__volatile__", "register", "inline", "__inline", "__inline__", "auto",
  "_Thread_local", "thread_local", "__thread", "typedef", "_Noreturn", "constexpr",
]);

/** Type keywords, and the specifiers a specifier macro may stand before (`leagueAtomic int n;`, `X static int f(`). */
export const BEFORE_MACRO_KEYWORDS = typesOf([
  "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "_Bool", "_Complex", "struct",
  "union", "enum", "static", "const", "volatile", "inline", "bool",
]);

/** Keywords whose `(…)` holds a condition or an operand, never a cast's type: `if (len) x = 1;`. */
export const NOT_BEFORE_CAST = typesOf(["if", "while", "for", "switch", "sizeof", "_Alignof", "return"]);

/** Keywords that start a statement: what may follow a statement macro's `)` besides `{` and a name. */
export const STATEMENT_KEYWORDS = typesOf(["if", "for", "while", "do", "switch", "return", "break", "continue", "goto"]);

/** `struct`, `union`, `enum`: the name after one is a tag, never a typedef name. */
export const TAG_KEYWORDS = typesOf(["struct", "union", "enum"]);

/** `const` and `volatile`: qualifiers the type scan looks past. */
export const QUALIFIER_KEYWORDS = typesOf(["const", "volatile", "__volatile__"]);

/** `typedef`. */
export const TYPEDEF = typesOf(["typedef"]);

/** `_Static_assert` / `static_assert`. */
export const STATIC_ASSERT = typesOf(["_Static_assert", "static_assert"]);
