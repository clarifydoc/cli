import { braceCodeHooks, type BraceLexicon } from "../shared/brace-code.js";
import type { CallPattern } from "../shared/regex-base.js";

const EXTENDED_STRING = /(#+)("""|")/y;

/** Swift's literal forms: `"""` blocks, quoted strings, and `#"…"#` / `#"""…"""#` raw strings. */
const SWIFT_LEXICON: BraceLexicon = {
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/", nests: true },
  strings: [
    { open: '"""', close: '"""', escapes: true, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
  ],
  rawString: (text, i) => {
    if (text[i] !== "#") return -1;
    EXTENDED_STRING.lastIndex = i;
    const m = EXTENDED_STRING.exec(text);
    if (!m) return -1;
    const close = text.indexOf(`${m[2]}${m[1]}`, i + m[0].length);
    return close < 0 ? text.length : close + m[2]!.length + m[1]!.length;
  },
};

/** Block ends counted over code only; the call scan reads `"""` blocks, raw strings and comments blanked. */
export const SWIFT_CODE = braceCodeHooks(SWIFT_LEXICON);

/** Lower-case words that open a block or declare something: `if x {`, `get {`, `didSet {`. */
const NOT_A_CALL = new Set(
  "if guard else do catch defer switch repeat while for in get set willSet didSet init deinit subscript func var let return throw throws rethrows where async await try case default some any is as lazy weak unowned mutating nonmutating override static class struct enum protocol extension import typealias associatedtype operator precedencegroup convenience required final open public private internal fileprivate inout actor nonisolated isolated macro package consuming borrowing".split(" "),
);

/**
 * A call whose only argument is a trailing closure: `try await withApp { app in
 * … }`, `DispatchQueue.main.async { … }`, `let task = makeTask { … }`. The
 * baseline sees no `(` there. Read only where an expression starts; a type
 * (`VStack {`) is a construction, and a member chained on a line before
 * (`.sink {`) has no receiver to name.
 */
export const TRAILING_CLOSURE_CALL: CallPattern = {
  pattern: /(?:^\s*|[=(,:]\s*|\breturn\s+)(?:(?:try[?!]?|await)\s+)*((?:[A-Za-z_]\w*\.)*[a-z_]\w*)\s*\{/g,
  buildName: (m) => {
    const name = m[1]!;
    const leafName = name.split(".").pop()!;
    // A keyword is never called; after a dot it is a member name (`queue.async {`).
    return NOT_A_CALL.has(name.split(".")[0]!) ? { name: "", leafName: "" } : { name, leafName };
  },
};
