import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { EXTENSION_TO_LANGUAGE, manifestFor } from "./extractors/registry.js";
import { buildMcpServer } from "./mcp/server.js";

/**
 * The README's facts that code owns: the MCP tools and the languages. A tool
 * or an extension added without its README line fails here, so the README
 * cannot quietly fall behind what ships.
 */
const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");

function section(heading: string): string {
  const start = readme.indexOf(`## ${heading}`);
  const end = readme.indexOf("\n## ", start + 3);
  return readme.slice(start, end < 0 ? undefined : end);
}

describe("README", () => {
  it("lists every MCP tool the server registers, and no other", () => {
    const listed = [...section("MCP server — for AI agents").matchAll(/^\| `(clarifydoc_[a-z_]+)`/gm)].map((m) => m[1]).sort();
    const registered = buildMcpServer({ projectRoot: resolve(__dirname, "..") }).tools.map((t) => t.name).sort();
    expect(listed).toEqual(registered);
  });

  it("names every analyzed extension in the row of its extraction path", () => {
    const rows = section("Supported languages");
    const row = (path: string) => rows.split("\n").find((l) => l.startsWith(`| **${path}**`)) ?? "";
    const missing: string[] = [];
    for (const [ext, language] of Object.entries(EXTENSION_TO_LANGUAGE)) {
      const parsing = manifestFor(language)?.parsing;
      const path = parsing === "tree-sitter" || parsing === "custom" ? "tree-sitter" : "regex";
      if (!row(path).includes(`\`${ext}\``)) missing.push(`${ext} (${language}, ${path})`);
    }
    expect(missing).toEqual([]);
  });
});
