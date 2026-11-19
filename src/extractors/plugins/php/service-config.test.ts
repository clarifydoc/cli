import { describe, it, expect } from "vitest";
import { phpServiceConfig, phpBaseRefOf } from "./service-config.js";

const parse = (text: string, path = "config/services.php") => phpServiceConfig.sources![0]!.parse(text, path);

describe("PHP service configuration", () => {
  it("reads nested config arrays, env() fallbacks included", () => {
    const entries = parse(`<?php
// the league service
return [
    'league' => ['url' => env('LEAGUE_API_URL', 'http://league-api:8080'), 'timeout' => 5],
    'archive' => ['url' => 'http://league-archive:8080'],
    'mail' => ['hosts' => ['a', 'b'], 'from' => env('MAIL_FROM')],
];`);
    expect(entries.map((e) => [e.key, e.value])).toEqual([
      ["services.league.url", "http://league-api:8080"],
      ["services.archive.url", "http://league-archive:8080"],
      ["services.mail.from", ""],
    ]);
    expect(entries[0]!.envNames).toEqual(["LEAGUE_API_URL"]);
  });

  it("reads what a base expression names", () => {
    expect(phpBaseRefOf("config('services.league.url')")).toEqual({ kind: "config", key: "services.league.url" });
    expect(phpBaseRefOf("env('LEAGUE_API_URL', 'http://league-api:8080')")).toEqual({ kind: "env", key: "LEAGUE_API_URL", fallback: "http://league-api:8080" });
    expect(phpBaseRefOf("$_ENV['LEAGUE_API_URL']")).toEqual({ kind: "env", key: "LEAGUE_API_URL" });
    expect(phpBaseRefOf("'http://league-api:8080'")).toEqual({ kind: "literal", key: "http://league-api:8080" });
    expect(phpBaseRefOf("$this->base")).toBeNull();
  });
});

import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpDataSourceExtractor } from "./data-sources.js";

async function calls(body: string) {
  const src = `<?php\nclass L {\n  function f() {\n${body}\n  }\n}`;
  const tree = await parseSource(src, "php" as any, "L.php");
  return new PhpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

describe("PHP calls state their configured base", () => {
  it("reads a config() base in front of the path", async () => {
    const [c] = await calls(`return Http::get(config('services.league.url') . '/api/clubs');`);
    expect(c).toMatchObject({ target: "/api/clubs", baseExpr: "config('services.league.url')" });
  });

  it("reads a Guzzle client's base_uri and an Http::baseUrl chain", async () => {
    const guzzle = await calls(`$client = new Client(['base_uri' => env('LEAGUE_API_URL', 'http://league-api:8080'), 'timeout' => 3]);\n$client->get('/api/players');`);
    expect(guzzle[0]).toMatchObject({ target: "/api/players", baseExpr: "env('LEAGUE_API_URL', 'http://league-api:8080')" });
    const chain = await calls(`Http::baseUrl(config('services.league.url'))->get('/api/players');`);
    expect(chain[0]).toMatchObject({ target: "/api/players", baseExpr: "config('services.league.url')" });
  });

  it("states no base for a client name bound to two bases", async () => {
    const rows = await calls(`$client = new Client(['base_uri' => 'http://league-api:8080']);\n$client = new Client(['base_uri' => 'http://league-archive:8080']);\n$client->get('/api/players');`);
    expect(rows[0]!.baseExpr).toBeUndefined();
  });

  it("leaves an absolute URL alone", async () => {
    const [c] = await calls(`Http::get('https://api.example.com/x');`);
    expect(c!.baseExpr).toBeUndefined();
  });
});
