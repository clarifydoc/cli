import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpDataSourceExtractor } from "./data-sources.js";
import { readPhpView } from "./views.js";
import type { FileAnalysis } from "../../../types/analysis.js";

describe("PHP api calls carry a column", () => {
  it("points a Guzzle call, a static Http call and a curl_exec at their start", async () => {
    const src = `<?php
class Sync {
  function run($client) {
    $s = "é🚗"; $client->get('/api/clubs');
    Http::post('/api/players');
    curl_exec($ch);
  }
}`;
    const tree = await parseSource(src, "php" as any, "Sync.php");
    const calls = new PhpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((d) => [d.line, d.column])).toEqual([[4, 16], [5, 4], [6, 4]]);
  });

  it("states a view script's column only where no PHP tag rewrote the line before it", () => {
    const a = { filePath: "views/clubs.php", language: "php", functions: [], classes: [], imports: [], dataSources: [], interactiveElements: [], screens: [], subComponents: [] } as unknown as FileAnalysis;
    readPhpView(a, `<div>
<script>
  fetch('/api/clubs');
  <?= $x ?> fetch('/api/players');
</script>
</div>`);
    expect(a.dataSources.filter((d) => d.kind === "api-call").map((d) => [d.line, d.column])).toEqual([[3, 2], [4, undefined]]);
  });
});
