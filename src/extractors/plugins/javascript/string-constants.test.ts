import { describe, it, expect } from "vitest";
import { extractStringConstants } from "./string-constants.js";
import { parseSource } from "../../../parsers/parser-manager.js";

async function constantsOf(source: string): Promise<Record<string, string>> {
  const tree = await parseSource(source, "typescript" as never, "constants.ts");
  return extractStringConstants(tree, source);
}

describe("extractStringConstants", () => {
  it("keeps exported strings, object members and string enum members, and nothing that is not plain", async () => {
    const out = await constantsOf([
      "export const LOAD_CLUBS = 'clubs/load';",
      "export const ACTIONS = { FETCH_CLUBS: 'clubs/fetchAll', nested: { DEEP: 'x' } } as const;",
      "export const FROZEN = Object.freeze({ SAVE: 'clubs/save' });",
      "export enum Kind { Club = 'club', Count = 3 }",
      "export const MESSAGE = 'two words';",
      "export const COMPUTED = `clubs/${name}`;",
      "const local = 'clubs/local';",
      "export const LABELS = { a: { b: { c: 'too-deep' } } };",
    ].join("\n"));
    expect(out).toEqual({
      LOAD_CLUBS: "clubs/load",
      "ACTIONS.FETCH_CLUBS": "clubs/fetchAll",
      "ACTIONS.nested.DEEP": "x",
      "FROZEN.SAVE": "clubs/save",
      "Kind.Club": "club",
      local: "clubs/local",
    });
  });
});
