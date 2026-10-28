/**
 * Calls read off a C-family ANTLR lexer's tokens, for code a parse does not read as expressions: a macro's arguments,
 * a `#define` inside a function, an `#if` branch the reading left out. Each language's token types come in a
 * `TokenKinds`, so one scanner serves the C and C++ lexers.
 */
import { CharStream, Token, type Lexer } from "antlr4ng";
import type { PatternCallName } from "./antlr-calls.js";
import { nameCall, type CalleeStep } from "./callee-names.js";

/** How many calls deep a chain is named. */
const CHAIN_DEPTH = 8;

/** The token types the scanner reads, as a lexer numbers them. */
export interface TokenKinds {
  identifier: number;
  dot: number;
  arrow: number;
  leftParen: number;
  /** `::`, when the language has it: `Club::create(` names its class, `ns::f(` the function alone. */
  scope?: number;
  /** `p->kick(` is `p.kick`, as `p.kick(` is (C++); else a member after `->` is named alone (C, where it calls through a function pointer). */
  memberArrow?: boolean;
  /** `ns::f(` is `ns.f` with the namespace path as its receiver type (C++), so no project member of the same name takes it. */
  namespaceQualified?: boolean;
  /** A directive token: `#define` among them. */
  directives: ReadonlySet<number>;
  /** Tokens before a name that make `name(` a declaration: `int f(`. */
  declares: ReadonlySet<number>;
  /** The language's lexer over a text. */
  lexer: (input: CharStream) => Lexer;
}

/** A function the reading found, with the lines its definition covers and the calls it makes so far. */
export interface CallOwner {
  calls: PatternCallName[];
  from: number;
  to: number;
}

const idStep = (token: Token): CalleeStep => ({ kind: "id", name: token.text ?? "", line: token.line, column: token.column });

/** The tokens of `text`, on every channel. */
export function lexAll(text: string, kinds: TokenKinds): Token[] {
  const lexer = kinds.lexer(CharStream.fromString(text));
  lexer.removeErrorListeners();
  return lexer.getAllTokens();
}

/** A `#define`'s name and parameters, before its body: `#define RND(a, b) \`. */
const DEFINE_HEAD = /^#\s*define\s+[A-Za-z_$][\w$]*(?:\([^)]*\))?/;

/** The calls of each `#define` written inside a function, which the function makes where it uses the macro. */
export function defineCalls(tokens: readonly Token[], kinds: TokenKinds, found: readonly CallOwner[]): void {
  for (const t of tokens) {
    if (!kinds.directives.has(t.type)) continue;
    const fn = found.find((f) => t.line >= f.from && t.line <= f.to);
    if (!fn) continue;
    const text = t.text ?? "";
    const head = DEFINE_HEAD.exec(text);
    if (!head) continue;
    // The body lexed in place: blank the head so lines and columns stay the file's.
    const body = "\n".repeat(t.line - 1) + " ".repeat(t.column + head[0].length) + text.slice(head[0].length).replace(/\\\r?\n/g, " \n");
    tokenCalls(lexAll(body, kinds).filter((b) => b.channel === Token.DEFAULT_CHANNEL), kinds, fn.calls);
  }
}

/** The calls of code a reading left out (`also`, lines in place) go to the function around each line. */
export function leftOutCalls(also: string, kinds: TokenKinds, found: readonly CallOwner[]): void {
  const tokens = lexAll(also, kinds);
  defineCalls(tokens, kinds, found);
  for (const fn of found) tokenCalls(tokens.filter((t) => t.channel === Token.DEFAULT_CHANNEL && t.line >= fn.from && t.line <= fn.to), kinds, fn.calls);
}

/**
 * The calls a run of tokens makes, named as the parse names them: `f(`, `a.b(`, a member after `->` alone (or as
 * after `.`, where the language says `memberArrow`), `Club::create(` on its class and `ns::f(` as `f` (or on its
 * namespace, where the language says `namespaceQualified`). A name after a type or another name (`int f(`, `T f(`)
 * declares a function rather than calling one.
 */
export function tokenCalls(tokens: readonly Token[], kinds: TokenKinds, calls: PatternCallName[]): void {
  let steps: CalleeStep[] = [];
  // The namespaces before the name in `steps` (`std`, `chrono` of `std::chrono::now`).
  let namespaces: string[] = [];
  let before = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const prev = tokens[i - 1]?.type ?? -1;
    if (t.type === kinds.identifier) {
      if (prev === kinds.dot || prev === kinds.arrow) {
        // A member of what no name spells (`).x(`) is named only after `->`, as the patterns read it.
        if (steps.length === 0) {
          steps = [{ kind: "other", bare: prev === kinds.arrow }];
          before = -1;
        } else if (prev === kinds.arrow && !(kinds.memberArrow && steps.at(-1)?.kind === "id")) steps.push({ kind: "other", bare: true });
        steps.push(idStep(t));
        namespaces = [];
      } else if (prev === kinds.scope && steps.length > 0) {
        // `Club::create` keeps its class; `ns::f` and `std::sort` are their function.
        const head = steps.at(-1)!;
        const isClass = head.kind === "id" && /^[A-Z]/.test(head.name);
        if (head.kind === "id" && !isClass && steps.length === 1) namespaces.push(head.name);
        else namespaces = [];
        steps = isClass ? [head, idStep(t)] : [idStep(t)];
      } else {
        steps = [idStep(t)];
        namespaces = [];
        before = prev;
      }
    } else if (t.type !== kinds.dot && t.type !== kinds.arrow && t.type !== kinds.scope) {
      if (t.type === kinds.leftParen && steps.at(-1)?.kind === "id" && !(before === kinds.identifier || kinds.declares.has(before))) {
        const leaf = steps[0]!;
        const named = kinds.namespaceQualified && namespaces.length > 0 && steps.length === 1 && leaf.kind === "id"
          ? { name: `${namespaces.at(-1)}.${leaf.name}`, leafName: leaf.name, line: leaf.line, column: leaf.column, receiverType: namespaces.join("::") }
          : nameCall(steps, CHAIN_DEPTH);
        if (named) calls.push(named);
      }
      steps = [];
      namespaces = [];
    }
  }
}
