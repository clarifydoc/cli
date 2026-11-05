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
  // A topic a function builds per subscriber (`pubsub.UserTopic(userID)`): named by that function,
  // which both ends call; `fmt.Sprintf("user-%d", id)` by its format.
  const sprintf = /^fmt\.Sprintf\(\s*"([^"\\]*)"\s*,[\s\S]*\)$/.exec(arg);
  if (sprintf) return sprintf[1]!.replace(/%[-+# 0-9.]*[sdvqx]/g, "{}");
  const builder = /^((?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*(?:Topic|Channel|Subject|Queue|Stream))\s*\([\s\S]*\)$/i.exec(arg);
  if (builder) return `${builder[1]}()`;
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

/** An AWS SDK v2 SQS/SNS call and the input struct it is handed: `client.SendMessage(ctx, &sqs.SendMessageInput{…})`. */
const AWS_CALL_RE = /\.\s*(SendMessage|SendMessageBatch|ReceiveMessage|Publish|PublishBatch)\s*\(/;
const AWS_INPUT_RE = /&?\b(sqs|sns)\.(\w+)Input\s*\{/;
const AWS_DESTINATION_RE = /\b(QueueUrl|TopicArn|TargetArn)\s*:\s*(?:aws\.String\(\s*)?("(?:[^"\\]|\\.)*"|`[^`]*`|[\w.]+)\s*\)?\s*,?/;

/**
 * The queue (`QueueUrl`) or topic (`TopicArn`) an AWS SDK v2 call names, as the
 * call's input struct states it — inline, or built into a local just above.
 * `value` reads the argument as a literal or constant; a name it cannot read
 * comes back in `ref` for the project pass. Null when the line is no such call.
 */
export function awsMessagingCall(
  lines: readonly string[],
  i: number,
  value: (arg: string | undefined) => string | null,
): { publish: boolean; method: string; target: string | null; ref?: string } | null {
  const call = AWS_CALL_RE.exec(lines[i]!);
  if (!call) return null;
  const args = callArgs(lines, i, call.index + call[0].length - 1);
  const input = args[1] ?? args[0] ?? "";
  let at = -1;
  let from = 0;
  const inline = AWS_INPUT_RE.exec(input);
  if (inline) {
    // The struct opens on this line or the next ones: its fields are read from the call's own text.
    at = i;
  } else if (/^&?[A-Za-z_]\w*$/.test(input)) {
    const name = input.replace(/^&/, "");
    for (let k = i - 1; k >= 0 && k >= i - 30; k--) {
      if (new RegExp(String.raw`\b${name}\s*:?=\s*&?\b(?:sqs|sns)\.\w+Input\s*\{`).test(lines[k]!)) { at = k; break; }
    }
  }
  if (at < 0) return null;
  const kind = (inline ?? /\b(sqs|sns)\.(\w+)Input\s*\{/.exec(lines[at]!))?.[2] ?? "";
  if (!/^(?:SendMessage|SendMessageBatch|ReceiveMessage|Publish|PublishBatch)$/.test(kind)) return null;
  let text = "";
  for (let k = at; k < Math.min(lines.length, at + 12); k++) {
    text += `${lines[k]!}\n`;
    if (k > at && /^\s*\}/.test(lines[k]!)) break;
  }
  from = text.search(/\b(?:sqs|sns)\.\w+Input\s*\{/);
  const dest = AWS_DESTINATION_RE.exec(text.slice(Math.max(from, 0)));
  const publish = kind !== "ReceiveMessage";
  if (!dest) return { publish, method: call[1]!, target: null };
  const raw = dest[2]!;
  const target = value(raw);
  return { publish, method: call[1]!, target, ...(target === null && /^[A-Za-z_][\w.]*$/.test(raw) ? { ref: raw } : {}) };
}
