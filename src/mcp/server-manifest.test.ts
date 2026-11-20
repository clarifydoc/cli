import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..");
const read = (name: string) => JSON.parse(readFileSync(join(root, name), "utf-8"));

/** `server.json` is the MCP registry entry; its fields follow the registry's server schema. */
describe("server.json (MCP registry entry)", () => {
  const server = read("server.json");
  const pkg = read("package.json");

  it("states the registry's required fields", () => {
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[\d-]+\/server\.schema\.json$/);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.name.length).toBeLessThanOrEqual(200);
    expect(typeof server.description).toBe("string");
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
    expect(server.repository).toMatchObject({ source: "github" });
    expect(server.repository.url).toBe("https://github.com/clarifydoc/cli");
  });

  it("names the npm package and the stdio command `clarifydoc mcp`", () => {
    expect(server.packages).toHaveLength(1);
    const p = server.packages[0];
    expect(p).toMatchObject({ registryType: "npm", identifier: pkg.name, transport: { type: "stdio" } });
    expect(p.packageArguments).toEqual([{ type: "positional", value: "mcp" }]);
    // The registry verifies an npm package by this field of its package.json.
    expect(pkg.mcpName).toBe(server.name);
  });

  it("carries the version package.json carries, and ships in the tarball", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(pkg.files).toContain("server.json");
  });
});
