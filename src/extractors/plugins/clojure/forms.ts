/**
 * A small Clojure form reader — enough of the reader to walk route DSLs
 * (Compojure lists, reitit vectors), destructuring maps and Malli/Schema
 * definitions without regexes that break on the first nested bracket. It
 * reads lists, vectors, maps, sets, strings, keywords, numbers and symbols;
 * comments, `#_` discards, quotes, metadata and reader tags are skipped so
 * the tree is the data the code would evaluate. Every node carries the
 * 1-based line it starts on. A malformed region throws; callers fall back.
 */

export type Form =
  | { kind: "list" | "vector" | "set"; items: Form[]; line: number }
  | { kind: "map"; entries: Array<[Form, Form]>; line: number }
  | { kind: "string"; value: string; line: number }
  | { kind: "keyword"; name: string; line: number }
  | { kind: "symbol"; name: string; line: number }
  | { kind: "number"; value: string; line: number };

/** A list / vector / set — the variants that carry `items`. */
export type SeqForm = Extract<Form, { items: Form[] }>;
export type SymbolForm = Extract<Form, { kind: "symbol" }>;
export type StringForm = Extract<Form, { kind: "string" }>;

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

class Reader {
  private pos = 0;
  private line = 1;

  constructor(private readonly src: string) {}

  /** Every top-level form in the source. */
  readAll(): Form[] {
    const out: Form[] = [];
    for (;;) {
      this.skipWs();
      if (this.pos >= this.src.length) return out;
      // A body slice (the lines after a `defn` head) closes forms it never
      // opened — a stray closer at the top level is skipped, not an error.
      if (")]}".includes(this.peek())) { this.advance(); continue; }
      const f = this.read();
      if (f) out.push(f);
    }
  }

  /** The first form only (a declaration starting at the head of `src`). */
  readOne(): Form | null {
    this.skipWs();
    return this.read();
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private advance(): string {
    const ch = this.src[this.pos++] ?? "";
    if (ch === "\n") this.line++;
    return ch;
  }

  private skipWs(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === "" ) return;
      if (ch === ";") {
        while (this.pos < this.src.length && this.peek() !== "\n") this.advance();
        continue;
      }
      if (/[\s,]/.test(ch)) { this.advance(); continue; }
      if (ch === "#" && this.src[this.pos + 1] === "_") {
        this.pos += 2;
        this.skipWs();
        this.read(); // discard the next form
        continue;
      }
      if (ch === "#" && this.src[this.pos + 1] === "!") {
        while (this.pos < this.src.length && this.peek() !== "\n") this.advance();
        continue;
      }
      return;
    }
  }

  /** One form, or null at a stray closer (which the caller consumes). */
  read(): Form | null {
    this.skipWs();
    const ch = this.peek();
    const line = this.line;
    if (ch === "") return null;
    if (ch === "(" || ch === "[") {
      this.advance();
      return { kind: ch === "(" ? "list" : "vector", items: this.readSeq(CLOSERS[ch]!), line };
    }
    if (ch === "{") {
      this.advance();
      return this.toMap(this.readSeq("}"), line);
    }
    if (ch === "#") {
      const next = this.src[this.pos + 1] ?? "";
      if (next === "{") { this.pos += 2; return { kind: "set", items: this.readSeq("}"), line }; }
      if (next === '"') { this.advance(); return this.readString(); }
      if (next === "(") { this.advance(); this.advance(); return { kind: "list", items: this.readSeq(")"), line }; }
      // Tagged literal `#inst "…"`, `#uuid`, `#js {…}`: skip the tag, read the value.
      this.advance();
      while (/[\w.:/-]/.test(this.peek())) this.advance();
      return this.read();
    }
    if (ch === '"') return this.readString();
    if (ch === "\\") {
      // Character literal `\a`, `\newline`.
      this.advance();
      let name = this.advance();
      while (/[\w-]/.test(this.peek())) name += this.advance();
      return { kind: "string", value: name, line };
    }
    if (ch === "'" || ch === "`" || ch === "~" || ch === "@" || ch === "^") {
      this.advance();
      if (ch === "~" && this.peek() === "@") this.advance();
      if (ch === "^") { this.read(); return this.read(); } // drop the metadata, keep the form
      return this.read();
    }
    if (ch === ")" || ch === "]" || ch === "}") return null;
    // Atom: keyword, number, symbol.
    let text = "";
    while (this.pos < this.src.length && !/[\s,()[\]{}"';]/.test(this.peek())) text += this.advance();
    if (text === "") { this.advance(); return this.read(); }
    if (text.startsWith(":")) return { kind: "keyword", name: text.replace(/^:+/, ""), line };
    if (/^[-+]?(?:\d|\.\d)/.test(text)) return { kind: "number", value: text, line };
    return { kind: "symbol", name: text, line };
  }

  private readSeq(closer: string): Form[] {
    const items: Form[] = [];
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === "") throw new Error(`unterminated form, expected ${closer}`);
      if (ch === closer) { this.advance(); return items; }
      if (ch === ")" || ch === "]" || ch === "}") throw new Error(`unexpected ${ch}, expected ${closer}`);
      const f = this.read();
      if (f) items.push(f);
    }
  }

  private toMap(items: Form[], line: number): Form {
    const entries: Array<[Form, Form]> = [];
    for (let i = 0; i + 1 < items.length; i += 2) entries.push([items[i]!, items[i + 1]!]);
    return { kind: "map", entries, line };
  }

  private readString(): Form {
    const line = this.line;
    this.advance(); // opening quote
    let value = "";
    for (;;) {
      const ch = this.advance();
      if (ch === "") throw new Error("unterminated string");
      if (ch === "\\") { value += this.advance(); continue; }
      if (ch === '"') return { kind: "string", value, line };
      value += ch;
    }
  }
}

/** Parse a whole source; throws on an unbalanced form. */
export function readForms(src: string): Form[] {
  return new Reader(src).readAll();
}

/** The first form of a source, or null when the reader cannot. */
export function tryReadFirst(src: string): Form | null {
  try {
    return new Reader(src).readOne();
  } catch {
    return null;
  }
}

/** Parse the forms of a source, or null when the reader cannot. */
export function tryReadForms(src: string): Form[] | null {
  try {
    return readForms(src);
  } catch {
    return null;
  }
}

/** Print a form back as compact Clojure text (for type texts and guard labels). */
export function printForm(f: Form): string {
  switch (f.kind) {
    case "string": return `"${f.value}"`;
    case "keyword": return `:${f.name}`;
    case "symbol": return f.name;
    case "number": return f.value;
    case "list": return `(${f.items.map(printForm).join(" ")})`;
    case "vector": return `[${f.items.map(printForm).join(" ")}]`;
    case "set": return `#{${f.items.map(printForm).join(" ")}}`;
    case "map": return `{${f.entries.map(([k, v]) => `${printForm(k)} ${printForm(v)}`).join(" ")}}`;
  }
}

export function isSymbol(f: Form | undefined, name?: string): f is Extract<Form, { kind: "symbol" }> {
  return !!f && f.kind === "symbol" && (name === undefined || f.name === name);
}

export function isKeyword(f: Form | undefined, name?: string): f is Extract<Form, { kind: "keyword" }> {
  return !!f && f.kind === "keyword" && (name === undefined || f.name === name);
}

/** Value under a keyword key of a map form. */
export function mapGet(f: Form | undefined, key: string): Form | undefined {
  if (!f || f.kind !== "map") return undefined;
  return f.entries.find(([k]) => isKeyword(k, key))?.[1];
}

/** Depth-first walk over every node. */
export function walk(f: Form, visit: (node: Form, parents: Form[]) => void, parents: Form[] = []): void {
  visit(f, parents);
  const next = [...parents, f];
  if (f.kind === "list" || f.kind === "vector" || f.kind === "set") for (const c of f.items) walk(c, visit, next);
  else if (f.kind === "map") for (const [k, v] of f.entries) { walk(k, visit, next); walk(v, visit, next); }
}
