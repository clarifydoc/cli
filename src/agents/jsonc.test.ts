import { describe, it, expect } from "vitest";
import { maskJsonc, parseJsonc, upsertJsoncMember } from "./jsonc.js";

const entry = { type: "local", command: ["/opt/garage/bin/node", "/opt/garage/cli.js", "mcp"], enabled: true };

describe("JSONC member upsert", () => {
  it("adds a server after the last one, keeping comments and the trailing comma", () => {
    const text = [
      "{",
      '  "$schema": "https://example.com/config.json",',
      "  // servers the garage uses",
      '  "mcp": {',
      '    "pitlane": { "type": "local", "command": ["pitlane"] }, // timing data',
      "  },",
      "  /* tyre pressures */",
      '  "theme": "dark",',
      "}",
      "",
    ].join("\n");
    const out = upsertJsoncMember(text, "mcp", "clarifydoc", entry)!;
    expect(out).toContain("// servers the garage uses");
    expect(out).toContain("// timing data");
    expect(out).toContain("/* tyre pressures */");
    expect(out).toContain('"pitlane": { "type": "local", "command": ["pitlane"] }, // timing data\n    "clarifydoc": {\n      "type": "local",');
    expect(parseJsonc(out)).toEqual({
      $schema: "https://example.com/config.json",
      mcp: { pitlane: { type: "local", command: ["pitlane"] }, clarifydoc: entry },
      theme: "dark",
    });
  });

  it("replaces an existing entry in place and creates the section when missing", () => {
    const replaced = upsertJsoncMember('{\n  // old\n  "mcp": { "clarifydoc": { "command": ["old"] } }\n}\n', "mcp", "clarifydoc", entry)!;
    expect(replaced).toContain("// old");
    expect(parseJsonc(replaced)).toEqual({ mcp: { clarifydoc: entry } });

    const created = upsertJsoncMember('{\n  // the car\n  "model": "coupe"\n}\n', "mcp", "clarifydoc", entry)!;
    expect(created).toContain("// the car");
    expect(parseJsonc(created)).toEqual({ model: "coupe", mcp: { clarifydoc: entry } });

    const empty = upsertJsoncMember("{\n  // nothing yet\n}\n", "servers", "clarifydoc", { command: "x" })!;
    expect(parseJsonc(empty)).toEqual({ servers: { clarifydoc: { command: "x" } } });
    expect(empty).toContain("// nothing yet");
  });

  it("keeps comment markers inside strings, and refuses what it cannot edit", () => {
    const text = '{ "url": "http://league.example/*not a comment*/", "mcp": {} }';
    expect(maskJsonc(text)).toBe(text);
    expect(parseJsonc(upsertJsoncMember(text, "mcp", "clarifydoc", { a: 1 })!)).toEqual({ url: "http://league.example/*not a comment*/", mcp: { clarifydoc: { a: 1 } } });
    expect(upsertJsoncMember('{ "mcp": [] }', "mcp", "clarifydoc", entry)).toBeNull();
    expect(upsertJsoncMember("{ broken", "mcp", "clarifydoc", entry)).toBeNull();
    expect(upsertJsoncMember("[1, 2]", "mcp", "clarifydoc", entry)).toBeNull();
  });
});
