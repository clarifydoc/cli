import { open } from "fs/promises";

/** Characters gathered before a slice is handed to the file. */
const FLUSH_AT = 1 << 20;
/** Containers this many levels down (or fewer) can wait for the file between members; deeper ones never do. */
const AWAIT_DEPTH = 3;
const DEEPEST = 2000;
/** A member with at least this many members of its own is walked by hand rather than inside a batch. */
const HAND_WALK_AT = 64;
/** The text one batch aims at. */
const BATCH_CHARS = 1 << 17;

const SKIP = Symbol("skip");

/** The value `JSON.stringify` would serialize in place of `v` (toJSON, boxed primitives), or SKIP for one it leaves out. */
function settle(v: unknown, key: string): unknown {
  if ((typeof v === "object" && v !== null) || typeof v === "bigint") {
    const toJson = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") v = toJson.call(v, key);
  }
  if (typeof v === "object" && v !== null) {
    if (v instanceof Number) return Number(v);
    if (v instanceof String) return String(v);
    if (v instanceof Boolean) return v.valueOf();
  }
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return SKIP;
  if (typeof v === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  return v;
}

/**
 * Serializes a value to a file in slices, so the whole text never exists as one string: the same bytes as
 * `JSON.stringify(value, null, indent)` for `indent` 0 or 2, which is how the analyzer's artifacts are written
 * (a differential test holds it to that). Writing only waits for the file between the members of the first
 * few levels — a summary's top-level fields and their rows — and a deeper subtree is serialized in one go.
 */
class SliceWriter {
  private buf = "";
  private readonly step: string;
  constructor(private readonly write: (text: string) => Promise<unknown>, indent: number) {
    this.step = indent > 0 ? " ".repeat(indent) : "";
  }

  async finish(): Promise<void> {
    if (this.buf) await this.write(this.buf);
    this.buf = "";
  }

  private async flushIfFull(): Promise<void> {
    if (this.buf.length < FLUSH_AT) return;
    const text = this.buf;
    this.buf = "";
    await this.write(text);
  }

  async root(value: unknown): Promise<void> {
    const v = settle(value, "");
    if (v === SKIP) return;
    await this.value(v, "", 0);
  }

  private primitive(v: unknown): boolean {
    if (v === null || typeof v !== "object") {
      this.buf += v === null ? "null" : typeof v === "number" || typeof v === "boolean" ? JSON.stringify(v) : JSON.stringify(v as string);
      return true;
    }
    return false;
  }

  /** How many members a container has — the measure of whether it is worth walking by hand. */
  private weight(v: unknown): number {
    if (Array.isArray(v)) return v.length;
    return Object.keys(v as object).length;
  }

  /**
   * A container at the first few levels. Its members are gathered into batches that go through one native
   * `JSON.stringify` call each (sized to about {@link BATCH_CHARS}), and a member that is itself a big container is walked
   * by hand, so the text held at any moment is a slice, never a field.
   */
  private async value(v: unknown, cur: string, depth: number): Promise<void> {
    if (this.primitive(v)) return;
    if (depth > DEEPEST) throw new TypeError("Converting circular structure to JSON");
    const isArray = Array.isArray(v);
    const keys = isArray ? null : Object.keys(v as object);
    const count = isArray ? (v as unknown[]).length : keys!.length;
    if (count === 0) {
      this.buf += isArray ? "[]" : "{}";
      return;
    }
    const pretty = this.step.length > 0;
    const inner = pretty ? cur + this.step : "";
    const sep = pretty ? ",\n" : ",";
    const open = isArray ? "[" : "{";
    const close = isArray ? "]" : "}";
    let opened = false;
    const begin = () => {
      if (opened) this.buf += sep;
      else {
        this.buf += open + (pretty ? "\n" : "");
        opened = true;
      }
    };
    let batchSize = 32;
    let list: unknown[] = [];
    let record: Record<string, unknown> = Object.create(null);
    let members = 0;
    const flushBatch = async (): Promise<void> => {
      if (members === 0) return;
      const text = JSON.stringify(isArray ? list : record, null, this.step.length) as string;
      list = [];
      record = Object.create(null);
      members = 0;
      if (!isArray && text === "{}") return;
      begin();
      const body = text.slice(pretty ? 2 : 1, pretty ? -2 : -1);
      this.buf += pretty ? cur + body.replaceAll("\n", "\n" + cur) : body;
      batchSize = Math.max(1, Math.min(4096, Math.round((batchSize * BATCH_CHARS) / Math.max(text.length, 1))));
      await this.flushIfFull();
    };
    for (let n = 0; n < count; n++) {
      const key = isArray ? String(n) : keys![n]!;
      const raw = isArray ? (v as unknown[])[n] : (v as Record<string, unknown>)[key];
      const m = settle(raw, key);
      const container = m !== SKIP && typeof m === "object" && m !== null;
      if (container && (typeof (m as { toJSON?: unknown }).toJSON === "function" || (depth < AWAIT_DEPTH && this.weight(m) >= HAND_WALK_AT))) {
        await flushBatch();
        begin();
        this.buf += pretty ? inner : "";
        if (!isArray) this.buf += JSON.stringify(key) + (pretty ? ": " : ":");
        if (typeof (m as { toJSON?: unknown }).toJSON === "function") this.valueHand(m, inner, depth + 1);
        else await this.value(m, inner, depth + 1);
        await this.flushIfFull();
        continue;
      }
      if (isArray) list.push(m === SKIP ? null : m);
      else if (m !== SKIP) record[key] = m;
      members++;
      if (members >= batchSize) await flushBatch();
    }
    await flushBatch();
    this.buf += opened ? (pretty ? "\n" + cur : "") + close : "{}";
  }

  /**
   * A subtree below the awaiting levels, in one native `JSON.stringify` call (the fast path; per-value calls from here
   * are several times slower), moved to the depth it sits at: the text holds no raw line break but between tokens, so
   * adding the margin after each is exact. A value that still has a `toJSON` of its own after its holder's was applied
   * is walked by hand instead, so the method is called once, as stringify does.
   */
  private valueSync(v: unknown, cur: string, depth: number): void {
    if (this.primitive(v)) return;
    if (typeof (v as { toJSON?: unknown }).toJSON === "function") {
      this.valueHand(v, cur, depth);
      return;
    }
    const text = JSON.stringify(v, null, this.step.length) as string;
    this.buf += cur ? text.replaceAll("\n", "\n" + cur) : text;
  }

  private valueHand(v: unknown, cur: string, depth: number): void {
    if (depth > DEEPEST) throw new TypeError("Converting circular structure to JSON");
    const inner = this.step ? cur + this.step : "";
    const nl = this.step ? "\n" : "";
    const sep = this.step ? ",\n" : ",";
    if (Array.isArray(v)) {
      if (v.length === 0) {
        this.buf += "[]";
        return;
      }
      this.buf += "[" + nl;
      for (let i = 0; i < v.length; i++) {
        if (i > 0) this.buf += sep;
        this.buf += inner;
        const m = settle(v[i], String(i));
        if (m === SKIP) this.buf += "null";
        else this.valueSync(m, inner, depth + 1);
      }
      this.buf += nl + cur + "]";
      return;
    }
    let first = true;
    for (const key of Object.keys(v as object)) {
      const m = settle((v as Record<string, unknown>)[key], key);
      if (m === SKIP) continue;
      if (first) {
        this.buf += "{" + nl;
        first = false;
      } else this.buf += sep;
      this.buf += inner + JSON.stringify(key) + (this.step ? ": " : ":");
      this.valueSync(m, inner, depth + 1);
    }
    this.buf += first ? "{}" : nl + cur + "}";
  }
}

/** Serialize `value` into `sink` in slices (the text of `JSON.stringify(value, null, indent)`, `indent` 0 or 2). */
export async function streamJson(value: unknown, indent: number, sink: (text: string) => Promise<unknown>): Promise<void> {
  const w = new SliceWriter(sink, indent);
  await w.root(value);
  await w.finish();
}

/** Write `value` as JSON to a file, as `JSON.stringify(value, null, indent)` would, without the whole text in memory. */
export async function writeJsonStream(outPath: string, value: unknown, indent: number): Promise<void> {
  const handle = await open(outPath, "w");
  try {
    await streamJson(value, indent, (text) => handle.write(text));
  } finally {
    await handle.close();
  }
}
