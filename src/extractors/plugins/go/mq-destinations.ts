/**
 * The queue, exchange or subject a Go messaging call names, read from its
 * arguments: a string literal, a string constant of the file, or a queue's
 * `.Name` where the file declared it (`q, err := ch.QueueDeclare("matches", …)`).
 */

/** The call's top-level arguments as written, from the `(` at `open` on line `i` (up to eight lines on). */
export function callArgs(lines: readonly string[], i: number, open: number): string[] {
  const text = [lines[i]!.slice(open + 1), ...lines.slice(i + 1, i + 8)].join("\n");
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if (quote) {
      if (c === "\\" && quote !== "`") k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "`" || c === "'") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) {
        const last = text.slice(start, k).trim();
        if (last || args.length > 0) args.push(last);
        return args;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(text.slice(start, k).trim());
      start = k + 1;
    }
  }
  return args;
}

const QUEUE_NAME_RE = /^([A-Za-z_]\w*)\.Name$/;

/** An argument's string value, or null when the file does not state it. */
export function argValue(arg: string | undefined, constants: ReadonlyMap<string, string>, lines: readonly string[], before: number): string | null {
  if (arg === undefined) return null;
  const lit = /^"((?:[^"\\]|\\.)*)"$|^`([^`]*)`$/.exec(arg);
  if (lit) return lit[1] ?? lit[2] ?? "";
  if (/^[A-Za-z_]\w*$/.test(arg)) return constants.get(arg) ?? null;
  const queue = QUEUE_NAME_RE.exec(arg)?.[1];
  if (!queue) return null;
  // `q, err := ch.QueueDeclare(name, …)` above the call: the name it declared.
  const decl = new RegExp(`\\b${queue}\\s*(?:,\\s*\\w+\\s*)?:?=\\s*\\w+\\.\\s*QueueDeclare\\s*\\(`);
  for (let k = before; k >= 0 && k >= before - 200; k--) {
    const m = decl.exec(lines[k]!);
    if (!m) continue;
    const first = callArgs(lines, k, m.index + m[0].length - 1)[0];
    return first !== undefined && !QUEUE_NAME_RE.test(first) ? argValue(first, constants, lines, k) : null;
  }
  return null;
}

/**
 * Where a publish goes: AMQP `Publish(exchange, key, mandatory, immediate, msg)`
 * (`PublishWithContext` after its context) goes to its exchange, or — the
 * default exchange `""` — to the queue its routing key names; any other
 * `Publish(subject, …)` to its first argument. Undefined when the call is not
 * of a shape read here.
 */
export function publishDestination(method: string, args: string[], value: (arg: string | undefined) => string | null): string | null | undefined {
  if (method === "PublishWithContext") args = args.slice(1);
  else if (method !== "Publish") return undefined;
  if (args.length >= 5) {
    const exchange = value(args[0]);
    return exchange ? exchange : exchange === "" ? value(args[1]) : null;
  }
  return value(args[0]);
}

/** Where a consume reads from: AMQP `Consume(queue, …)`, NATS `Subscribe(subject, …)` — the first argument. */
export function consumeDestination(method: string, args: string[], value: (arg: string | undefined) => string | null): string | null | undefined {
  if (method !== "Consume" && method !== "Subscribe" && method !== "QueueSubscribe" && method !== "ChanSubscribe") return undefined;
  return value(args[0]);
}
