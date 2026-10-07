import type { CallPattern } from "../shared/regex-base.js";

/** A Raku name: hyphens and apostrophes inside (`get-user`, `isn't`). */
const NAME = String.raw`[A-Za-z_][\w'-]*[\w]`;
const SHORT_NAME = String.raw`[A-Za-z_]\w*`;
export const ANY_NAME = String.raw`(?:${NAME}|${SHORT_NAME})`;
export const QUALIFIED = String.raw`${ANY_NAME}(?:::${ANY_NAME})*`;
export const SCOPE = String.raw`(?:(?:my|our|only|proto|multi)\s+)*`;

/** Statement words that read like a call: `if(…)`, `for(…)`, `given(…)`. */
const KEYWORDS = new Set([
  "if", "elsif", "unless", "while", "until", "for", "loop", "given", "when", "with", "without", "orwith", "return",
  "die", "fail", "take", "gather", "react", "whenever", "supply", "start", "await", "my", "our", "has", "sub", "method",
  "submethod", "multi", "proto", "class", "role", "grammar", "module", "unit", "use", "need", "require", "is", "does",
  "say", "put", "print", "note", "so", "not", "defined", "try", "CATCH", "CONTROL", "LEAVE", "ENTER", "KEEP", "UNDO",
  "emit", "done", "last", "next", "redo", "succeed", "proceed", "temp", "let", "state", "constant", "subset", "enum",
  "where", "and", "or", "xor", "andthen", "orelse", "eq", "ne", "lt", "gt", "le", "ge", "cmp", "leg", "x", "xx", "but",
]);

export const RAKU_CALLS: CallPattern[] = [
  {
    // `get-user($id)`, `Cro::HTTP::Client.new(…)`'s `new`, `DBIish.connect(…)`.
    pattern: new RegExp(String.raw`(?<![\w$@%&.!:'-])(?!(?:${[...KEYWORDS].join("|")})\()(${QUALIFIED})\(`),
    buildName: (m) => ({ name: m[1]!, leafName: m[1]!.split("::").pop()! }),
  },
  {
    // A method call: `$repo.find($id)`, `self.save`, `$!db.execute: $sql`, `Order.new(…)`.
    // A bare receiver is a type, so capitalized (`use v6.d;` calls nothing).
    // Without parentheses it is a call at a statement's end, or anywhere
    // when kebab-cased (`to-json($orders.open-orders)`) — a one-word one
    // mid-expression is usually an attribute read (`$order.total`).
    pattern: new RegExp(String.raw`(?:(self)|[$@%&][.!]?(${ANY_NAME})|(?<![\w.-])((?=[A-Z])${QUALIFIED}))\.(${ANY_NAME})(?:(?=\s*[(:;]|\s*$)|(?<=-[\w']+))`),
    buildName: (m) => {
      const recv = m[1] ? "self" : m[2] ?? m[3]!;
      return { name: `${recv}.${m[4]}`, leafName: m[4]! };
    },
  },
  {
    // A list operator — a call without parentheses, at the start of a
    // statement: `content 'text/plain', $body`, `notify-customer $order;`.
    pattern: new RegExp(String.raw`(?:^|[{;])\s*(?!(?:${[...KEYWORDS].join("|")})\b(?![\w'-]))([a-z][\w'-]*[\w]|[a-z])[ \t]+(?=['"$@%&(\[<]|[A-Za-z_])(?!(?:if|unless|for|with|given|where|and|or|x|xx|eq|ne|cmp|but|does|is)\b)`),
    buildName: (m) => ({ name: m[1]!, leafName: m[1]! }),
  },
];
for (const c of RAKU_CALLS) c.replacesBaseline = true;

