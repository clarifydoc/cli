import { describe, it, expect } from "vitest";
import "../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../parsers/parser-manager.js";
import { BashDataSourceExtractor } from "./bash/data-sources.js";
import { RDataSourceExtractor } from "./r/data-sources.js";
import { JuliaDataSourceExtractor } from "./julia/data-sources.js";
import { OCamlDataSourceExtractor } from "./ocaml/data-sources.js";
import { ZigDataSourceExtractor } from "./zig/data-sources.js";
import { FSharpDataSourceExtractor } from "./fsharp/data-sources.js";
import type { DataSourceExtractor } from "../data-sources/base.js";

/** The call's node starts where the token does (character columns, after a non-ASCII prefix). */
const SAMPLES: Array<{ language: string; file: string; make: () => DataSourceExtractor; src: string; token: string }> = [
  { language: "bash", file: "a.sh", make: () => new BashDataSourceExtractor(), src: 's="é🚗"; curl https://clubs.example/api/clubs', token: "curl" },
  { language: "r", file: "a.R", make: () => new RDataSourceExtractor(), src: 's <- "é🚗"; httr::GET("https://clubs.example/api/clubs")', token: "httr::GET" },
  { language: "julia", file: "a.jl", make: () => new JuliaDataSourceExtractor(), src: 's = "é🚗"; HTTP.get("https://clubs.example/api/clubs")', token: "HTTP.get" },
  { language: "ocaml", file: "a.ml", make: () => new OCamlDataSourceExtractor(), src: 'let s = "é🚗" let r = Client.get (Uri.of_string "https://clubs.example/api/clubs")', token: "Client.get" },
  { language: "zig", file: "a.zig", make: () => new ZigDataSourceExtractor(), src: 'fn load(client: *Client) !void { const s = "é🚗"; _ = try client.fetch(.{ .location = .{ .url = "https://clubs.example/api/clubs" }, .method = .GET }); }', token: "client.fetch" },
  { language: "fsharp", file: "a.fs", make: () => new FSharpDataSourceExtractor(), src: 'let load (client: HttpClient) =\n    let s = "é🚗" in client.GetAsync("/api/clubs")', token: "client.GetAsync" },
];

describe("tree-sitter plugins: api calls carry a column", () => {
  for (const s of SAMPLES) {
    it(`${s.language}: the call node's start`, async () => {
      const tree = await parseSource(s.src, s.language as never, s.file);
      const rows = s.make().extract(tree, s.src).filter((d) => d.kind === "api-call");
      expect(rows.length).toBe(1);
      const line = s.src.split("\n")[rows[0]!.line - 1]!;
      expect(rows[0]!.column).toBe(line.indexOf(s.token));
    });
  }
});
