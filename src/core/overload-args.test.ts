import { describe, it, expect } from "vitest";
import { argFit, bestOverload, type TypeHierarchy } from "./overload-args.js";

/** Car ← Van, Lorry implements an external `Serializable`. */
const types: TypeHierarchy = {
  ancestors(t) {
    if (t === "Car") return { names: new Set(), closed: true };
    if (t === "Van") return { names: new Set(["Car"]), closed: true };
    if (t === "Lorry") return { names: new Set(["Serializable"]), closed: false };
    return null;
  },
};

describe("argFit", () => {
  it("ranks exact over assignable over unknown, and rules out the impossible", () => {
    expect(argFit("string", "string", types)).toBe(3);
    expect(argFit("int", "long", types)).toBe(2);
    expect(argFit("Van", "Car", types)).toBe(2);
    expect(argFit("string", "object", types)).toBe(1);
    expect(argFit("string", "CharSequence", types)).toBe(1); // an external type may be a supertype
    expect(argFit("@x", "Car", types)).toBe(1);
    expect(argFit("string", "int", types)).toBe(0);
    expect(argFit("long", "int", types)).toBe(0); // narrowing
    expect(argFit("string", "Car", types)).toBe(0);
    expect(argFit("Car", "Van", types)).toBe(0); // a supertype is no subtype, and Car's supertypes are all known
    expect(argFit("Lorry", "Comparable", types)).toBe(1); // Lorry's supertypes are not all known
    expect(argFit("ByteArray", "Car", types)).toBe(0); // an external type never extends a project class
    expect(argFit("null", "int", types)).toBe(0);
    expect(argFit("null", "Car", types)).toBe(1);
  });

  it("matches a lambda's arity and result against a functional parameter", () => {
    expect(argFit("->0:void", "->0:void", types)).toBe(3);
    expect(argFit("->0:void", "->0:value", types)).toBe(0);
    expect(argFit("->0", "->0:value", types)).toBe(2); // an expression body could be either
    expect(argFit("->1:void", "->0:void", types)).toBe(0);
    expect(argFit("->", "->1:value", types)).toBe(2); // arity open
    expect(argFit("->0:void", "string", types)).toBe(0);
    expect(argFit("->0:void", "Car", types)).toBe(1); // a project interface might be functional
  });
});

describe("bestOverload", () => {
  it("picks the overload the arguments fit best, -1 on a tie or when nothing is known", () => {
    const score = [{ types: ["string", "int"], variadic: false }, { types: ["object", "string"], variadic: false }];
    expect(bestOverload(["string", "int"], score, types)).toBe(0);
    expect(bestOverload(["string", "string"], score, types)).toBe(1);
    expect(bestOverload(["@a", "?"], score, types)).toBe(-1);
    const run = [{ types: ["->0:void"], variadic: false }, { types: ["->0:value"], variadic: false }];
    expect(bestOverload(["->0"], run, types)).toBe(-1);
    expect(bestOverload(["->0:void"], run, types)).toBe(0);
  });

  it("does not compare arguments past a variadic parameter", () => {
    const log = [{ types: ["string", "object"], variadic: true }, { types: ["int", "string"], variadic: false }];
    expect(bestOverload(["string", "int"], log, types)).toBe(0);
  });
});
