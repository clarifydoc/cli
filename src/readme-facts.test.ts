import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { EXTENSION_TO_LANGUAGE, manifestFor } from "./extractors/registry.js";
import { buildMcpServer } from "./mcp/server.js";
import { LANGUAGES_END, LANGUAGES_START, withLanguageTable } from "./readme-facts.js";

/**
 * The README's facts that code owns: the MCP tools and the languages. A tool
 * or an extension added without its README line fails here, so the README
 * cannot quietly fall behind what ships.
 */
const README = resolve(__dirname, "../README.md");
// `npm run readme:facts` writes the generated blocks; a plain test run only checks them.
if (process.env.README_FACTS_WRITE) writeFileSync(README, withLanguageTable(readFileSync(README, "utf8")));
const readme = readFileSync(README, "utf8");

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

  it("carries the language table the registry generates, between its markers", () => {
    expect(readme).toContain(LANGUAGES_START);
    expect(readme).toContain(LANGUAGES_END);
    expect(readme, "the README's language table is out of date: npm run readme:facts").toBe(withLanguageTable(readme));
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
