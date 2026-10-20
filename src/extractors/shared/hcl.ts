/**
 * A tolerant reader for HCL (Terraform `.tf`): blocks with their labels,
 * attributes with their expressions as written, nested blocks.
 *
 *   resource "aws_lambda_function" "orders" {     → { type: "resource", labels: ["aws_lambda_function", "orders"],
 *     handler = "index.handler"                        attrs: { handler: "\"index.handler\"", … },
 *     environment { variables = { A = "1" } }          blocks: [{ type: "environment", … }] }
 *   }
 *
 * Expressions are kept as source text (`aws_sqs_queue.jobs.arn`,
 * `"${path.module}/src"`, `jsonencode({…})`); `hclString` and `hclRefs`
 * read the two things the passes need from them. Comments (`#`, `//`,
 * `/* *\/`), heredocs and `${…}` interpolation inside strings are skipped
 * correctly; anything else malformed ends the block it is in, never the file.
 */

export interface HclBlock {
  type: string;
  labels: string[];
  attrs: Map<string, string>;
  blocks: HclBlock[];
  /** 1-based line of the block's first token. */
  line: number;
}

export function parseHcl(text: string): HclBlock[] {
  let i = 0;
  const n = text.length;
  const lineAt = (pos: number): number => {
    let l = 1;
    for (let k = 0; k < pos && k < n; k++) if (text.charCodeAt(k) === 10) l++;
    return l;
  };

  const skipSpace = (newlines: boolean): void => {
    while (i < n) {
      const c = text[i]!;
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) i++;
      else if (c === "#" || (c === "/" && text[i + 1] === "/")) while (i < n && text[i] !== "\n") i++;
      else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
      } else break;
    }
  };

  /** Past a string starting at `i` (the opening quote), `${…}` interpolations included. */
  const skipString = (): void => {
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === "\\") i += 2;
      else if ((text[i] === "$" || text[i] === "%") && text[i + 1] === "{") {
        i += 2;
        skipBalanced("}");
      } else i++;
    }
    i++;
  };

  /** Past a heredoc starting at `i` (`<<EOF` / `<<-EOF`). */
  const skipHeredoc = (): void => {
    const m = /^<<-?([A-Za-z_]\w*)/.exec(text.slice(i, i + 64));
    if (!m) {
      i += 2;
      return;
    }
    // Up to the terminator, leaving the newline after it: that ends the attribute.
    const end = new RegExp(String.raw`\n[ \t]*${m[1]}[ \t]*(?=\n|$)`).exec(text.slice(i));
    i = end ? i + end.index! + end[0].length : n;
  };

  /** Past the closing `close` of a bracket whose opener was just consumed. */
  const skipBalanced = (close: string): void => {
    const stack = [close];
    while (i < n && stack.length) {
      const c = text[i]!;
      if (c === '"') skipString();
      else if (c === "<" && text[i + 1] === "<") skipHeredoc();
      else if (c === "#" || (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))) skipSpace(false);
      else if (c === "{" || c === "[" || c === "(") {
        stack.push(c === "{" ? "}" : c === "[" ? "]" : ")");
        i++;
      } else if (c === stack[stack.length - 1]) {
        stack.pop();
        i++;
      } else i++;
    }
  };

  /** An attribute's expression: to the end of its line, brackets and strings spanning lines. */
  const readExpression = (): string => {
    const start = i;
    while (i < n) {
      const c = text[i]!;
      if (c === "\n" || c === "}") break;
      if (c === '"') skipString();
      else if (c === "<" && text[i + 1] === "<") skipHeredoc();
      else if (c === "{" || c === "[" || c === "(") {
        i++;
        skipBalanced(c === "{" ? "}" : c === "[" ? "]" : ")");
      } else if (c === "#" || (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))) break;
      else i++;
    }
    return text.slice(start, i).trim();
  };

  const readBody = (): HclBlock & { attrsOnly?: never } => {
    const body: HclBlock = { type: "", labels: [], attrs: new Map(), blocks: [], line: lineAt(i) };
    for (;;) {
      skipSpace(true);
      if (i >= n || text[i] === "}") return body;
      const start = i;
      const ident = /^[A-Za-z_][\w-]*/.exec(text.slice(i, i + 256));
      if (!ident) {
        // Unreadable: skip the line.
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      i += ident[0].length;
      skipSpace(false);
      if (text[i] === "=" && text[i + 1] !== "=") {
        i++;
        skipSpace(false);
        body.attrs.set(ident[0], readExpression());
        continue;
      }
      // A block: labels, then `{`.
      const labels: string[] = [];
      while (i < n && text[i] !== "{" && text[i] !== "\n") {
        if (text[i] === '"') {
          const s = i;
          skipString();
          labels.push(text.slice(s + 1, i - 1));
        } else {
          const l = /^[A-Za-z_][\w-]*/.exec(text.slice(i, i + 256));
          if (l) {
            labels.push(l[0]);
            i += l[0].length;
          } else i++;
        }
        skipSpace(false);
      }
      if (text[i] !== "{") continue;
      i++;
      const inner = readBody();
      i++; // the closing `}`
      body.blocks.push({ type: ident[0], labels, attrs: inner.attrs, blocks: inner.blocks, line: lineAt(start) });
    }
  };

  const top: HclBlock[] = [];
  while (i < n) {
    const body = readBody();
    top.push(...body.blocks);
    if (i < n) i++; // a stray `}` at the top
  }
  return top;
}

/** A plain string literal's value (`"index.handler"` → `index.handler`); null for any other expression. */
export function hclString(expr: string | undefined): string | null {
  if (!expr) return null;
  const m = /^"((?:[^"\\$]|\\.|\$(?!\{))*)"$/.exec(expr.trim());
  return m ? m[1]!.replace(/\\"/g, '"') : null;
}

/** A string with `${path.module}`/`${path.root}` resolved against the module's directory (others left as written). */
export function hclPath(expr: string | undefined, moduleDir: string): string | null {
  if (!expr) return null;
  const m = /^"([^"]*)"$/.exec(expr.trim());
  if (!m) return null;
  const v = m[1]!.replace(/\$\{path\.(?:module|cwd)\}/g, moduleDir || ".").replace(/\$\{path\.root\}/g, ".");
  return v.includes("${") ? null : v;
}

/** The resource references in an expression: `aws_sqs_queue.jobs.arn` → [{ type: "aws_sqs_queue", name: "jobs", attr: "arn" }]. */
export function hclRefs(expr: string | undefined): Array<{ type: string; name: string; attr?: string }> {
  if (!expr) return [];
  const out: Array<{ type: string; name: string; attr?: string }> = [];
  for (const m of expr.matchAll(/\b(data\.)?([a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)(?:\[[^\]]*\])?(?:\.([A-Za-z_]\w*))?/g)) {
    out.push({ type: (m[1] ?? "") + m[2]!, name: m[3]!, ...(m[4] ? { attr: m[4] } : {}) });
  }
  return out;
}
