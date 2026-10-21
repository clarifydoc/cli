import type { CallInfo, ClassInfo, DataSourceInfo, FunctionInfo } from "../../../types/analysis.js";

/**
 * ActiveJob / Sidekiq enqueues and ActionMailer deliveries. The work of a
 * request often runs in a job: `ScoreJob.perform_later(match)` returns at
 * once and the job's `perform` writes the tables later. The enqueue is
 * reported both ways — as a `queue-publish` on the queue named after the job
 * (its `perform` is the `queue-consume`), and as a call of `ScoreJob#perform`,
 * so a route's reach goes on through the job to what it touches.
 */

const CONST = String.raw`[A-Z]\w*(?:::[A-Z]\w*)*`;
/** Balanced-enough argument list: one level of nested parens (`set(wait: 5.minutes)`, `with(club: find(id))`). */
const ARGS = String.raw`\((?:[^()]|\([^()]*\))*\)`;

/** `ScoreJob.perform_later(…)`, `ScoreJob.set(wait: 1.minute).perform_later`, Sidekiq `perform_async`/`perform_in`/`perform_at`. */
const ENQUEUE_RE = new RegExp(String.raw`(?<![\w.@$:])(?:::)?(${CONST})(?:\.set\s*${ARGS})?\.(perform_later|perform_now|perform_async|perform_in|perform_at|perform_bulk)\b`, "g");

/** `ClubMailer.with(club: c).welcome.deliver_later` / `ClubMailer.welcome(c).deliver_now`. */
const MAILER_RE = new RegExp(String.raw`(?<![\w.@$:])(?:::)?(${CONST}Mailer)(?:\.with\s*${ARGS})?\.([a-z_]\w*)(?:\s*${ARGS})?\.deliver_(?:later|now)!?`, "g");

/** The last segment: queues are named by the job class as both sides write it (`::ScoreJob`, `Leagues::ScoreJob` in a module). */
const queueName = (cls: string): string => cls.split("::").pop()!;

/** The calls an enqueue or a delivery makes: the job's `perform`, the mailer's method. */
export function addJobDispatchCalls(lines: readonly string[], fn: FunctionInfo): void {
  const have = new Map(fn.calls.map((c) => [`${c.name}@${c.line}`, c]));
  const add = (call: CallInfo): void => {
    const key = `${call.name}@${call.line}`;
    const written = have.get(key);
    // The parenthesised spelling is already a call: it gains the type it is made on.
    if (written) { written.receiverType ??= call.receiverType; return; }
    have.set(key, call);
    fn.calls.push(call);
  };
  for (let i = fn.line - 1; i < Math.min(fn.endLine, lines.length); i++) {
    const code = (lines[i] ?? "").replace(/\s#.*$/, "");
    if (!code.includes(".perform_") && !code.includes(".deliver_")) continue;
    for (const m of code.matchAll(ENQUEUE_RE)) {
      add({ name: `${m[1]}.perform`, kind: "internal", target: null, line: i + 1, receiverType: m[1]! });
    }
    for (const m of code.matchAll(MAILER_RE)) {
      if (m[2] === "with") continue;
      add({ name: `${m[1]}.${m[2]}`, kind: "internal", target: null, line: i + 1, receiverType: m[1]! });
    }
  }
}

/** A job class: it extends a `…Job` base (`ApplicationJob`, `ActiveJob::Base`) or mixes in Sidekiq. */
function isJobClass(cls: ClassInfo): boolean {
  if (cls.extends && /(?:^|::)(?:\w*Job|ActiveJob::Base)$/.test(cls.extends)) return true;
  return cls.implements.some((i) => /^Sidekiq::(?:Worker|Job)$/.test(i));
}

/** `queue-publish` at each enqueue, `queue-consume` at each job class's `perform`. */
export function extractJobQueueSources(lines: readonly string[], classes: readonly ClassInfo[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const code = (lines[i] ?? "").replace(/\s#.*$/, "");
    if (!code.includes(".perform_") || code.trimStart().startsWith("#")) continue;
    for (const m of code.matchAll(ENQUEUE_RE)) {
      out.push({ kind: "queue-publish", name: `ActiveJob: ${m[2]}`, target: queueName(m[1]!), calls: [], line: i + 1 });
    }
  }
  for (const cls of classes) {
    if (!isJobClass(cls)) continue;
    const perform = cls.methods.find((m) => m.name === "perform");
    if (perform) out.push({ kind: "queue-consume", name: "ActiveJob: perform", target: queueName(cls.name), calls: [], line: perform.line });
  }
  return out;
}
