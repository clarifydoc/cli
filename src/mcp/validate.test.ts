import { describe, it, expect } from "vitest";
import { nearest, validateArguments } from "./validate.js";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    kind: { type: "string", enum: ["api", "frontend"] },
    limit: { type: "number" },
    full: { type: "boolean" },
    kinds: { type: "array", items: { type: "string", enum: ["route", "screen", "file"] } },
    files: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

describe("validateArguments", () => {
  it("accepts what the lenient argument helpers accept", () => {
    expect(validateArguments(schema, {})).toEqual([]);
    expect(
      validateArguments(schema, {
        path: "src/a.ts",
        kind: "API", // enumArg matches case-insensitively
        limit: "20", // numberArg reads numeric strings
        full: "yes", // booleanArg reads yes/no
        kinds: "route,screen", // stringArrayArg splits a comma list
        files: ["a", "b"],
      }),
    ).toEqual([]);
    expect(validateArguments(schema, { kind: null, limit: undefined, kind2: undefined } as Record<string, unknown>)).toHaveLength(1);
  });

  it("rejects a misspelt key, naming the right one and the full list", () => {
    const [problem] = validateArguments(schema, { paths: "src/a.ts" });
    expect(problem).toMatch(/Unknown argument `paths` — did you mean `path`\?/);
    expect(problem).toMatch(/This tool takes: `path`, `kind`/);
  });

  it("rejects an enum value that matches nothing, instead of reading it as no filter", () => {
    expect(validateArguments(schema, { kind: "backend" })[0]).toMatch(/`backend` is not one of `api`, `frontend`/);
    expect(validateArguments(schema, { kind: "fronted" })[0]).toMatch(/did you mean `frontend`/);
    expect(validateArguments(schema, { kinds: ["route", "screens"] })[0]).toMatch(/did you mean `screen`/);
  });

  it("rejects values the helpers would silently replace with their default", () => {
    expect(validateArguments(schema, { limit: "all" })[0]).toMatch(/`limit` must be a number/);
    expect(validateArguments(schema, { full: "maybe" })[0]).toMatch(/true or false/);
    expect(validateArguments(schema, { files: { a: 1 } })[0]).toMatch(/must be a list/);
  });

  it("leaves schemas that allow extra keys alone", () => {
    expect(validateArguments({ properties: {} }, { anything: 1 })).toEqual([]);
    expect(validateArguments({ properties: {}, additionalProperties: false }, { x: 1 })[0]).toMatch(/takes no arguments/);
  });
});

describe("nearest", () => {
  it("suggests only what is close enough to be a typo", () => {
    expect(nearest("methd", ["method", "path"])).toBe("method");
    expect(nearest("zzzzzz", ["method", "path"])).toBeUndefined();
  });
});
