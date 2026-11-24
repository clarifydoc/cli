import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { streamJson } from "./json-stream.js";

async function streamed(value: unknown, indent: number, ...slices: never[]): Promise<string> {
  let out = "";
  await streamJson(value, indent, async (t) => (out += t));
  return out;
}

class Club {
  constructor(public name: string) {}
  toJSON(key: string): unknown {
    return { club: this.name, key };
  }
}

describe("streamJson", () => {
  const cases: Record<string, unknown> = {
    primitives: [0, -0, 1.5e300, 1e-7, NaN, Infinity, "x", true, null, 123456789012345680000],
    skipped: { a: undefined, b: () => 1, c: Symbol("s"), d: 1, e: [undefined, () => 1, Symbol("x")] },
    empty: { a: {}, b: [], c: [[]], d: [{}], e: { f: { g: [] } } },
    onlyUndefined: { a: undefined },
    escapes: { "k\"ey\n": "tab\t\"quote\" back\\ nl\n   \u0000 \u001f \u007f é 球员 🏆" },
    surrogates: ["\ud83c", "\udc00", "a\ud83cb", "\u{1F3C6}", { "\ud800": "\udfff\ud800" }],
    toJSON: { when: new Date(Date.UTC(2026, 10, 24)), club: new Club("United"), list: [new Club("City")] },
    boxed: [new Number(3), new String("s"), new Boolean(false)],
    containers: { m: new Map([[1, 2]]), s: new Set([1]), t: new Uint8Array([1, 2]) },
    order: { b: 1, 2: "two", a: 2, 1: "one" },
    sparse: [1, , 3],
    root: "just text",
    ownProto: JSON.parse('{"__proto__":{"x":1},"a":2}'),
  };
  for (const [name, value] of Object.entries(cases)) {
    for (const indent of [0, 2]) {
      it(`${name}, indent ${indent}`, async () => {
        const want = JSON.stringify(value, null, indent);
        expect(await streamed(value, indent)).toBe(want);
      });
    }
  }

  it("matches on a deep and wide value across slice boundaries", async () => {
    const rows = Array.from({ length: 60000 }, (_, i) => ({ id: i, name: `Player ${i} é`, tags: ["a", "b"], nested: { deep: { deeper: { x: [i, { y: null }] } } } }));
    const value = { rows, more: { rows } };
    for (const indent of [0, 2]) {
      let slices = 0;
      let out = "";
      await streamJson(value, indent, async (t) => {
        slices++;
        out += t;
      });
      expect(slices).toBeGreaterThan(2);
      expect(out).toBe(JSON.stringify(value, null, indent));
    }
  });

  it("matches on generated values of every shape and size", async () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const make = (depth: number): unknown => {
      const kind = rnd(depth > 4 ? 5 : 8);
      if (kind === 0) return rnd(1000) / 7;
      if (kind === 1) return `s${rnd(50)}\n\u{1F3C6}\ud800`;
      if (kind === 2) return rnd(2) ? null : undefined;
      if (kind === 3) return rnd(2) === 0;
      if (kind === 4) return () => 1;
      const size = rnd(4) === 0 ? 70 + rnd(300) : rnd(6);
      if (kind <= 5) return Array.from({ length: size }, () => make(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < size; i++) o[rnd(3) === 0 ? String(rnd(500)) : rnd(40) === 0 ? "__proto__" : `k${rnd(900)}`] = make(depth + 1);
      return o;
    };
    for (let round = 0; round < 60; round++) {
      const value = [make(0)];
      for (const indent of [0, 2]) expect(await streamed(value, indent)).toBe(JSON.stringify(value, null, indent));
    }
  });

  it("throws where stringify throws", async () => {
    await expect(streamed({ n: 1n }, 2)).rejects.toThrow(TypeError);
    const loop: Record<string, unknown> = {};
    loop.me = loop;
    await expect(streamed(loop, 2)).rejects.toThrow(TypeError);
  });

  it("matches on the fixtures' summaries", async () => {
    const root = join(__dirname, "..", "..", "test-output");
    if (!existsSync(root)) return;
    let checked = 0;
    for (const dir of readdirSync(root)) {
      const path = join(root, dir, "project-summary.json");
      if (!existsSync(path)) continue;
      const value = JSON.parse(readFileSync(path, "utf-8"));
      for (const indent of [0, 2]) expect(await streamed(value, indent)).toBe(JSON.stringify(value, null, indent));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
