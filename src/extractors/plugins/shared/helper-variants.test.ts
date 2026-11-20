import { describe, expect, it } from "vitest";
import { splitTopLevel } from "../../shared/split-top-level.js";
import { middlewareGuardOf } from "../../shared/route-metadata.js";
import { dropNestedFunctions, tidySetupCalls } from "./function-postprocess.js";
import { lineAt, lineIndex, preparedLines } from "./text-scan.js";
import { underscore } from "./inflection.js";
import { escapeRegex } from "./path-utils.js";
import { hasDep } from "./project-info-queries.js";
import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";

const samples = [
  "", "a", "\n", "one\ntwo", "one\n\nthree\n", "x = 1;\ny = 2;\r\nz", "\n\n\n", "αβγ\nδ", "a\nb\nc\nd\ne",
];

describe("lineAt offset counters", () => {
  // The bodies the plugins declared inline before they used the shared counter.
  const slicing = (text: string, i: number) => text.slice(0, i).split("\n").length;
  it("lineAt equals the slice-and-split count at every offset", () => {
    for (const text of samples) for (let i = 0; i <= text.length + 2; i++) expect(lineAt(text, i), `${JSON.stringify(text)}@${i}`).toBe(slicing(text, i));
  });
  // The binary-search closure go/huma, go/di-bindings, protobuf and thrift each declared.
  const legacyIndex = (text: string) => {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    return (offset: number) => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
  };
  it("lineIndex equals the closure the plugins declared", () => {
    for (const text of samples) {
      const a = lineIndex(text), b = legacyIndex(text);
      for (let i = 0; i <= text.length + 2; i++) expect(a(i)).toBe(b(i));
    }
  });
  it("preparedLines blanks, indexes and caches per lines array", () => {
    const prepared = preparedLines((t) => t.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length)));
    const lines = ["a // x", "b"];
    const p = prepared(lines);
    expect(p.text).toBe("a     \nb");
    expect(p.lineAt(p.text.indexOf("b"))).toBe(2);
    expect(prepared(lines)).toBe(p);
    expect(prepared(["a // x", "b"])).not.toBe(p);
  });
});

describe("splitTopLevel with lineComment (go/huma splitTop)", () => {
  function skipString(text: string, start: number): number {
    const q = text[start]!;
    for (let i = start + 1; i < text.length; i++) {
      if (q !== "`" && text[i] === "\\") { i++; continue; }
      if (text[i] === q) return i;
    }
    return text.length;
  }
  function legacy(body: string): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch === '"' || ch === "'" || ch === "`") { i = skipString(body, i); continue; }
      if (ch === "/" && body[i + 1] === "/") { const nl = body.indexOf("\n", i); i = nl < 0 ? body.length : nl; continue; }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
    }
    const tail = body.slice(start);
    if (tail.trim()) out.push(tail);
    return out.map((s) => s.trim()).filter(Boolean);
  }
  const shared = (b: string) => splitTopLevel(b, { quotes: "\"'`", escapes: "\"'", lineComment: "//", trim: true, dropBlank: true });
  it("matches the replaced body", () => {
    const inputs = [
      "", "A, B", "Method: http.MethodGet, Path: \"/clubs/{id}\", // the, list\n Tags: []string{\"a\", \"b\"},",
      "x: `a,b\\`, c`, y", "f(a, b), g{c, d}, [e, f]", "\"unterminated, a", "a, , b,", "a // c, d", "a, // c\n", "'\\',', b", "\"\\\",\", z",
    ];
    for (const t of inputs) expect(shared(t), t).toEqual(legacy(t));
  });
  it("the newline ending a comment still separates", () => {
    expect(splitTopLevel("a // x\nb", { sep: "\n", lineComment: "//" })).toEqual(["a // x", "b"]);
  });
  it("a comment opener is not read without the option", () => {
    expect(splitTopLevel("a // x, y", { trim: true })).toEqual(["a // x", "y"]);
  });
});

describe("function-postprocess", () => {
  it("dropNestedFunctions equals the filter the two plugins declared", () => {
    const spans: Array<[number, number]> = [[1, 20], [5, 8], [30, 40]];
    const fns = [{ line: 1, endLine: 20 }, { line: 5, endLine: 8 }, { line: 6, endLine: 7 }, { line: 25, endLine: 28 }, { line: 31, endLine: 40 }];
    const legacy = fns.filter((fn) => !spans.some(([start, end]) => start < fn.line && end >= fn.endLine));
    expect(dropNestedFunctions(fns, spans)).toEqual(legacy);
  });
  it("tidySetupCalls rewrites only the <setup> function", () => {
    const call = (name: string) => ({ name }) as CallInfo;
    const drop = (calls: CallInfo[]) => calls.filter((c) => c.name !== "end");
    const setup = { name: "<setup>", calls: [call("end"), call("run")] } as FunctionInfo;
    const other = { name: "go", calls: [call("end")] } as FunctionInfo;
    tidySetupCalls([other, setup], drop);
    expect(setup.calls.map((c) => c.name)).toEqual(["run"]);
    expect(other.calls).toHaveLength(1);
    expect(() => tidySetupCalls([other], drop)).not.toThrow();
  });
});

describe("middlewareGuardOf (swift and dart middlewareGuard)", () => {
  const legacy = (expr: string, authRe: RegExp, schemeRe: RegExp) => {
    const text = expr.replace(/\s+/g, " ").trim();
    if (!authRe.test(text)) return null;
    const name = text.replace(/\(.*$/s, "");
    return schemeRe.test(name)
      ? { text, anonymous: false, policies: [], roles: [], schemes: [name] }
      : { text, anonymous: false, policies: [name], roles: [], schemes: [] };
  };
  const scheme = /jwt|basic|bearer|token|session/i;
  const swiftAuth = /authenticator|guard|auth|jwt|token|session/i;
  const dartAuth = /auth|jwt|token|session|guard/i;
  it("equals the replaced bodies for each framework's own words", () => {
    for (const e of ["User.guardMiddleware()", "JWTAuthenticator( secret )", "  LogMiddleware ", "SessionAuth\n  ()", "cors()", "Match.authenticator"]) {
      expect(middlewareGuardOf(e, swiftAuth, scheme)).toEqual(legacy(e, swiftAuth, scheme));
      expect(middlewareGuardOf(e, dartAuth, scheme)).toEqual(legacy(e, dartAuth, scheme));
    }
  });
});

describe("underscore against the rust entity extractor's snake", () => {
  const legacy = (s: string) => (s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
  const shared = (s: string) => underscore(s ?? "").replace(/[\s-]+/g, "_");
  it("is the same on every spelling", () => {
    for (const s of ["", "ClubMember", "HTTPServer", "match-report", "Match Report", "Club  Player", "X", "ABC", "player2Team", "a-B c", "Car_Garage", "--Club"]) expect(shared(s), s).toBe(legacy(s));
  });
});

describe("escapeRegex shared by the project-info queries", () => {
  it("escapes a name the way the replaced copy did", () => {
    const legacy = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const s of ["", "a.b", "Club(Player)", "x*y+z?", "[a]{1}|^$\\"]) expect(escapeRegex(s)).toBe(legacy(s));
    expect(hasDep({ packageJson: { dependencies: { "club.js": "1" } } } as never, "club.js")).toBe(true);
  });
});
