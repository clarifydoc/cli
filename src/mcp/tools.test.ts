import { describe, it, expect, beforeAll } from "vitest";
import { join } from "path";
import { buildMcpServer } from "./server.js";
import { normalizePath, resolveFilePath, type LoadedAnalysis, type RouteWithFile } from "./store.js";
import type { McpServer } from "./protocol.js";

/**
 * The tools are exercised against the committed fixture analyses in
 * `test-output/` (the regenerated fixture analyses), with analysis
 * and cold start disabled so a test can never kick off a scan. Expectations are derived from
 * the loaded summary rather than hardcoded, so regenerating a fixture cannot
 * make these tests lie.
 */
function serverFor(
  fixture: string,
  opts: { allowAnalyze?: boolean; allowColdStart?: boolean; analysisDir?: string } = {},
) {
  return buildMcpServer({
    projectRoot: join("test-fixtures", fixture),
    analysisDir: opts.analysisDir ?? join("test-output", fixture),
    allowAnalyze: opts.allowAnalyze ?? false,
    // Cold start is on by default in production (an agent bootstraps itself);
    // here it must stay off, or a fixture with no analysis would scan for real.
    allowColdStart: opts.allowColdStart ?? false,
  });
}

interface CallOutcome {
  text: string;
  isError: boolean;
}

async function call(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallOutcome> {
  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(res?.error, `tools/call ${name} failed at the protocol level`).toBeUndefined();
  const result = res?.result as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0].text, isError: result.isError === true };
}

describe("clarifydoc MCP tools — react fixture", () => {
  const { server, store } = serverFor("sample-react");
  let loaded: LoadedAnalysis;

  beforeAll(async () => {
    loaded = await store.load();
  });

  it("exposes the documented tool set, all read-only except analyze", async () => {
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res?.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "clarifydoc_status",
      "clarifydoc_search",
      "clarifydoc_routes",
      "clarifydoc_contract",
      "clarifydoc_services",
      "clarifydoc_screens",
      "clarifydoc_file",
      "clarifydoc_trace",
      "clarifydoc_extract",
      "clarifydoc_blast_radius",
      "clarifydoc_data_model",
      "clarifydoc_data_flows",
      "clarifydoc_health",
      "clarifydoc_architecture",
      "clarifydoc_impact",
      "clarifydoc_control_flow",
      "clarifydoc_analyze",
      "clarifydoc_explain",
    ]);
    expect(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      "clarifydoc_analyze",
    ]);
  });

  it("architecture lists modules with instability, hubs and communities", async () => {
    const call = async (args: Record<string, unknown>) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "clarifydoc_architecture", arguments: args } });
      return ((res?.result as { content: Array<{ text: string }> }).content[0]!.text);
    };
    expect(await call({})).toMatch(/^# Architecture — /);
    expect(await call({ view: "modules", depth: 1 })).toMatch(/instability \d\.\d\d/);
    expect(await call({ view: "hubs" })).toMatch(/degree \d+/);
    expect(await call({ view: "cochange" })).toMatch(/co-change|change together/i);
  });

  it("status reports the project, its counts and the analysis directory", async () => {
    const { text, isError } = await call(server, "clarifydoc_status");
    expect(isError).toBe(false);
    expect(text).toContain("# ClarifyDoc — sample-react");
    expect(text).toContain(`files: ${loaded.summary.files.length}`);
    expect(text).toMatch(/api routes: \d+/);
    expect(text).toContain("analysis dir:");
  });

  it("search finds a route by path and honours the kinds filter", async () => {
    const route = loaded.summary.routeMap[0];
    const { text } = await call(server, "clarifydoc_search", { query: route.path, kinds: ["route"] });
    expect(text).toContain(route.path);
    expect(text).toContain("[route]");
    expect(text).not.toContain("[file]");
  });

  it("search ranks across kinds in one list, best first", async () => {
    const route = loaded.summary.routeMap[0];
    const { text } = await call(server, "clarifydoc_search", { query: route.path });
    // One tally line, then one ranked list — never a per-kind section.
    expect(text).toMatch(/^\d+ hits? · /m);
    expect(text).not.toContain("## ");
    // The route the query names exactly must lead, whatever else matched.
    const first = text.split("\n").find((l) => l.startsWith("- "));
    expect(first).toContain("[route]");
    expect(first).toContain(route.path);
  });

  it("search matches terms independently and splits camelCase", async () => {
    // A two-word query is a miss under substring matching; both words appear in
    // this symbol's name, in order, so the ranked list must contain it.
    const fn = loaded.summary.complexity
      ?.flatMap((f) => f.functions)
      .find((f) => /^[a-z]+[A-Z][a-z]+/.test(f.functionName));
    expect(fn, "fixture has no camelCase function to search for").toBeDefined();
    const words = fn!.functionName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    const { text } = await call(server, "clarifydoc_search", { query: words, limit: 50 });
    expect(text).toContain(`${fn!.functionName}()`);
  });

  it("search reports a miss without erroring", async () => {
    const { text, isError } = await call(server, "clarifydoc_search", { query: "zzz-not-a-thing-zzz" });
    expect(isError).toBe(false);
    expect(text).toContain("No matches");
  });

  it("search names the term worth keeping when only some of them match", async () => {
    // A two-letter fragment can only substring-match, which is below the bar
    // the loose pass sets (a term must NAME something), so this really misses
    // — and the fragment is still the half of the query worth keeping.
    const fragment = loaded.summary.screens[0].name.slice(0, 2).toLowerCase();
    const { text } = await call(server, "clarifydoc_search", {
      query: `${fragment} zzzqqqnotathing`,
    });
    expect(text).toContain("`zzzqqqnotathing` matches nothing");
    expect(text).toContain(`clarifydoc_search query="${fragment}"`);
  });

  /**
   * The standing rule, as a gate: a result with no rows in it must name the
   * tool that would have data. Written as a table so a tool added later is one
   * line away from being covered, instead of relying on whoever writes its
   * empty branch to remember.
   */
  it.each([
    ["clarifydoc_search", { query: "zzz-not-a-thing-zzz" }],
    ["clarifydoc_routes", { path: "/zzz-not-a-thing" }],
    ["clarifydoc_contract", { path: "/zzz-not-a-thing" }],
    ["clarifydoc_services", { project: "zzz-not-a-thing" }],
    ["clarifydoc_screens", { query: "zzz-not-a-thing" }],
    ["clarifydoc_trace", { symbol: "zzzNotAThing" }],
    ["clarifydoc_data_flows", { resource: "zzz-not-a-thing" }],
    ["clarifydoc_health", { category: "security", file: "zzz-not-a-thing" }],
  ])("%s points at another tool when it has nothing to show", async (name, args) => {
    const { text, isError } = await call(server, name, args);
    expect(isError, `${name} treated an empty result as a failure`).toBe(false);
    const next = text.split("\n").find((line) => line.startsWith("Next: "));
    expect(next, `${name} returned no Next: line:\n${text}`).toBeDefined();
    // A suggestion counts when it is another tool, or the same tool with a
    // different argument (drilling into another health category is a real next
    // step). What it may never be is "call this again", unchanged.
    const actionable = next!.slice("Next: ".length).split(" · ").filter((suggestion) => {
      const tool = suggestion.match(/clarifydoc_[a-z_]+/)?.[0];
      return tool !== undefined && (tool !== name || /\w+=|without `/.test(suggestion));
    });
    expect(actionable, `${name} suggested no call worth making:\n${text}`).not.toHaveLength(0);
  });

  it("routes lists declarations with file:line and the frontend callers of an endpoint", async () => {
    const { text } = await call(server, "clarifydoc_routes", { limit: 100 });
    expect(text).toMatch(/^# Routes \(\d+ match/m);
    // routeMap is typed RouteInfo[], but the aggregation attaches the file.
    const first = loaded.summary.routeMap[0] as RouteWithFile;
    expect(text).toContain(`${first.filePath}:${first.line}`);
    const link = loaded.summary.apiRouteLinks?.[0];
    if (link) {
      const target = await call(server, "clarifydoc_routes", { path: link.routePath });
      expect(target.text).toContain("called from:");
      expect(target.text).toContain(link.source);
    }
  });

  it("services lifts cross-project links to one edge per project pair, with its endpoints", async () => {
    const deps = loaded.summary.projectDependencies ?? [];
    expect(deps.length, "fixture has no cross-project dependency").toBeGreaterThan(0);
    const names = new Map(loaded.summary.subProjects!.map((p) => [p.id, p.name]));
    const { text, isError } = await call(server, "clarifydoc_services");
    expect(isError).toBe(false);
    expect(text).toMatch(/^# Project dependencies — \d+ edges? between \d+ projects?/m);
    for (const d of deps) {
      expect(text).toContain(`${names.get(d.from)} → ${names.get(d.to)} [${d.kind}]`);
      expect(text).toContain(d.endpoints[0]!.name);
    }
    const one = await call(server, "clarifydoc_services", { project: names.get(deps[0]!.to)! });
    expect(one.text).toContain(`${names.get(deps[0]!.from)} → ${names.get(deps[0]!.to)}`);
  });

  it("routes names a caller's project when it calls across projects", async () => {
    const link = (loaded.summary.apiRouteLinks ?? []).find(
      (l) => l.sourceProject !== undefined && l.sourceProject !== l.targetProject,
    );
    expect(link, "fixture has no cross-project link").toBeDefined();
    const name = loaded.summary.subProjects!.find((p) => p.id === link!.sourceProject)!.name;
    const { text } = await call(server, "clarifydoc_routes", { path: link!.routePath });
    expect(text).toContain(`${link!.source}:${link!.sourceLine} [${name}]`);
  });

  it("routes explains an empty filter result instead of returning nothing", async () => {
    const { text } = await call(server, "clarifydoc_routes", { method: "TRACE", kind: "api" });
    expect(text).toContain("No routes match");
    expect(text).toMatch(/The analysis holds \d+ routes/);
    // Two filters were passed and only one of them is the reason, so the hint
    // must name that one rather than telling the caller to try again.
    expect(text).toContain("clarifydoc_routes without `method`");
  });

  it("screens names the page, its route and the endpoints it calls", async () => {
    const screen = loaded.summary.screens[0];
    const { text } = await call(server, "clarifydoc_screens", { query: screen.name });
    expect(text).toContain(screen.name);
    expect(text).toContain(screen.filePath);
  });

  it("file resolves a bare basename and reports its facts", async () => {
    const withFunctions = loaded.summary.complexity?.find((c) => c.functions.length > 0);
    expect(withFunctions, "fixture should have at least one file with functions").toBeDefined();
    const basename = withFunctions!.filePath.split("/").pop()!;
    const { text, isError } = await call(server, "clarifydoc_file", { path: basename });
    expect(isError).toBe(false);
    expect(text).toContain(`# ${withFunctions!.filePath}`);
    expect(text).toContain("## Functions");
    expect(text).toContain(withFunctions!.functions[0].functionName);
  });

  it("file limits itself to the requested sections", async () => {
    const path = loaded.summary.complexity!.find((c) => c.functions.length > 0)!.filePath;
    const { text } = await call(server, "clarifydoc_file", { path, sections: ["overview"] });
    expect(text).not.toContain("## Functions");
  });

  it("file names the candidates when a path is ambiguous or unknown", async () => {
    const unknown = await call(server, "clarifydoc_file", { path: "definitely/not/here.ts" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("No analyzed file matches");

    const ambiguous = await call(server, "clarifydoc_file", { path: ".tsx" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/matches \d+ files/);
  });

  it("trace walks callers and callees of a symbol", async () => {
    const link = loaded.summary.symbolLinks[0];
    const { text, isError } = await call(server, "clarifydoc_trace", {
      symbol: link.targetSymbol,
      depth: 2,
    });
    expect(isError).toBe(false);
    expect(text).toContain("# Call trace");
    expect(text).toContain("## Callers");
    expect(text).toContain(link.sourceFile);
  });

  it("trace `to` names the call path between two symbols, hop by hop", async () => {
    // A two-hop chain from the fixture itself: a → b → c.
    const links = loaded.summary.symbolLinks;
    const key = (f: string, s: string) => `${f}::${s}`;
    let chain: [typeof links[number], typeof links[number]] | undefined;
    for (const first of links) {
      const second = links.find((l) =>
        key(l.sourceFile, l.sourceSymbol) === key(first.targetFile, first.targetSymbol) &&
        key(l.targetFile, l.targetSymbol) !== key(first.sourceFile, first.sourceSymbol) &&
        !links.some((d) => key(d.sourceFile, d.sourceSymbol) === key(first.sourceFile, first.sourceSymbol) &&
          key(d.targetFile, d.targetSymbol) === key(l.targetFile, l.targetSymbol)));
      if (second && !first.sourceSymbol.includes(" ") && !second.targetSymbol.includes(" ")) { chain = [first, second]; break; }
    }
    expect(chain, "fixture has a two-hop call chain").toBeDefined();
    const [first, second] = chain!;
    const { text } = await call(server, "clarifydoc_trace", {
      symbol: first.sourceSymbol, file: first.sourceFile, to: second.targetSymbol, toFile: second.targetFile,
    });
    expect(text).toContain("# Call paths");
    expect(text).toMatch(/2 hops/);
    expect(text).toContain(`→ ${first.targetSymbol}()`);
    expect(text).toContain(`→ ${second.targetSymbol}()`);
  });

  it("extract returns a function's source and its callees within the budget", async () => {
    // A call into a function or method the fixture defines.
    const link = loaded.summary.symbolLinks.find((l) => (l.relation ?? "calls") === "calls" && l.sourceFile !== l.targetFile && !l.sourceSymbol.includes(" ") && !l.sourceSymbol.startsWith("<"));
    expect(link, "fixture has a cross-file call").toBeDefined();
    const { text } = await call(server, "clarifydoc_extract", { symbol: link!.sourceSymbol, file: link!.sourceFile, depth: 1 });
    expect(text).toContain(`## ${link!.sourceSymbol}() — ${link!.sourceFile}:`);
    expect(text).toContain("```");
    expect(text).toMatch(new RegExp(`${link!.targetSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(\\).*hop 1`));

    const tight = await call(server, "clarifydoc_extract", { symbol: link!.sourceSymbol, file: link!.sourceFile, depth: 1, maxTokens: 200 });
    expect(tight.text).toMatch(/Withheld|hop 1/);

    const miss = await call(server, "clarifydoc_extract", { symbol: "zzzNoSuchFunction" });
    expect(miss.isError).toBe(false);
    expect(miss.text).toContain("No function or method named");
  });

  it("trace names the definitions of an ambiguous name instead of merging them", async () => {
    const links = loaded.summary.symbolLinks;
    // A leaf name two different definitions share, if the fixture has one.
    const byLeaf = new Map<string, Set<string>>();
    for (const l of links) {
      const leaf = l.targetSymbol.split(".").pop()!;
      if (!byLeaf.has(leaf)) byLeaf.set(leaf, new Set());
      byLeaf.get(leaf)!.add(`${l.targetFile}::${l.targetSymbol}`);
    }
    const shared = [...byLeaf].find(([leaf, defs]) => defs.size > 1 && /^\w+$/.test(leaf));
    if (!shared) return;
    const { text } = await call(server, "clarifydoc_trace", { symbol: shared[0] });
    expect(text).toMatch(/names \d+ definitions — pick one/);
    expect(text).toContain('clarifydoc_trace symbol="');
  });

  it("trace requires a seed and says so when nothing resolves", async () => {
    const noSeed = await call(server, "clarifydoc_trace", {});
    expect(noSeed.isError).toBe(true);
    expect(noSeed.text).toContain("Pass `symbol`, `file`, or both");

    const miss = await call(server, "clarifydoc_trace", { symbol: "zzzNoSuchSymbol" });
    expect(miss.isError).toBe(false);
    expect(miss.text).toContain("No call-graph edges match");
  });

  it("blast radius ranks the project and details one file", async () => {
    const ranked = await call(server, "clarifydoc_blast_radius", { limit: 5 });
    expect(ranked.text).toContain("# Highest-impact files");

    const target = [...(loaded.summary.blastRadius ?? [])].sort(
      (a, b) => b.impactScore - a.impactScore,
    )[0];
    const detail = await call(server, "clarifydoc_blast_radius", { path: target.filePath });
    expect(detail.text).toContain(`# Blast radius — ${target.filePath}`);
    expect(detail.text).toContain(`risk: ${target.changeRisk}`);
  });

  it("impact projects an explicit changed-file list without touching git", async () => {
    const changed = loaded.summary.files[0];
    const { text, isError } = await call(server, "clarifydoc_impact", { files: [changed] });
    expect(isError).toBe(false);
    expect(text).toContain("ClarifyDoc impact");
    expect(text).toContain(changed);
  });

  it("health summarizes the score and drills into a category", async () => {
    const summary = await call(server, "clarifydoc_health");
    expect(summary.text).toContain("# Health — sample-react");
    expect(summary.text).toContain("## Findings available");

    const complexity = await call(server, "clarifydoc_health", { category: "complexity", limit: 3 });
    expect(complexity.text).toContain("# Most complex functions");
  });

  it("health lists dead code: unreachable files first, then unused exports and imports", async () => {
    const dead = loaded.summary.deadCode!;
    expect(dead.files.length).toBeGreaterThan(0);
    const total = dead.files.length + dead.exports.length + (dead.unusedImportCount ?? 0);
    const summary = await call(server, "clarifydoc_health");
    expect(summary.text).toContain(`dead-code: ${total} — call with category="dead-code"`);

    const { text, isError } = await call(server, "clarifydoc_health", { category: "dead-code", limit: 2 });
    expect(isError).toBe(false);
    expect(text).toContain(`## Unreachable files (${dead.files.length})`);
    expect(text).toContain(dead.files[0]!.filePath);
    if (dead.exports.length > 0) expect(text).toContain(`## Unused exports (${dead.exports.length})`);
    if (dead.unusedImportCount) expect(text).toContain(`## Unused imports (${dead.unusedImportCount})`);
    // Capped, and says so.
    if (dead.files.length > 2) expect(text).not.toContain(dead.files[2]!.filePath);
  });

  it("refuses to analyze when the server is read-only", async () => {
    const { text, isError } = await call(server, "clarifydoc_analyze");
    expect(isError).toBe(true);
    expect(text).toContain("read-only");
  });

  it("serves file facts through the resource template, and the workflow prompts", async () => {
    const file = loaded.summary.files[0]!;
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: `clarifydoc://file/${file}` } });
    expect((res?.result as { contents: Array<{ text: string }> }).contents[0].text).toContain(file);
    const prompt = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "before-editing", arguments: { file } } });
    const text = (prompt?.result as { messages: Array<{ content: { text: string } }> }).messages[0].content.text;
    expect(text).toContain(`clarifydoc_blast_radius path="${file}"`);
  });

  it("serves the status resource", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "clarifydoc://analysis/status" },
    });
    const contents = (res?.result as { contents: Array<{ text: string }> }).contents;
    expect(contents[0].text).toContain("# ClarifyDoc — sample-react");
  });
});

describe("clarifydoc MCP tools — data tier", () => {
  it("lists ORM entities and describes one with its columns and relations", async () => {
    const { server, store } = serverFor("sample-orm");
    const loaded = await store.load();
    const node = loaded.summary.entityGraph!.nodes.find((n) => n.columns.length > 0)!;

    const inventory = await call(server, "clarifydoc_data_model");
    expect(inventory.text).toContain("# Data model —");
    expect(inventory.text).toContain(node.name);

    const detail = await call(server, "clarifydoc_data_model", { entity: node.name });
    expect(detail.text).toContain(`# ${node.name} [`);
    expect(detail.text).toContain("## Columns");
    expect(detail.text).toContain(node.columns[0].name);
  });

  it("suggests near misses for an unknown entity name", async () => {
    const { server, store } = serverFor("sample-orm");
    const loaded = await store.load();
    const node = loaded.summary.entityGraph!.nodes[0];
    const { text } = await call(server, "clarifydoc_data_model", {
      entity: node.name.slice(0, Math.max(2, node.name.length - 1)),
    });
    // Either an exact hit (short names) or the near misses — never silence.
    expect(text).toMatch(/contain the name|# /);
  });

  it("groups route/screen → data-effect flows by entry point", async () => {
    const { server, store } = serverFor("sample-ruby-web");
    const loaded = await store.load();
    const flows = loaded.summary.dataFlows ?? [];
    expect(flows.length, "ruby fixture should carry data flows").toBeGreaterThan(0);

    const { text } = await call(server, "clarifydoc_data_flows");
    expect(text).toContain("# Data flows —");
    expect(text).toContain(flows[0].resource);

    const filtered = await call(server, "clarifydoc_data_flows", { effect: "queue-publish" });
    expect(filtered.text).toMatch(/# Data flows|No data flows match/);
  });

  it("says so when a project has no extracted data model", async () => {
    const { server } = serverFor("sample-rust-cli");
    const { text } = await call(server, "clarifydoc_data_model");
    expect(text).toContain("No entities or tables were extracted");
  });
});

describe("clarifydoc MCP tools — missing analysis", () => {
  it("reports a missing analysis instead of failing opaquely", async () => {
    const { server } = serverFor("sample-react", {
      analysisDir: join("test-output", "does-not-exist-clarifydoc-mcp"),
    });
    const { text, isError } = await call(server, "clarifydoc_status");
    expect(isError).toBe(true);
    expect(text).toContain("No ClarifyDoc analysis exists");
  });
});

describe("path resolution", () => {
  it("normalizes separators, ./ prefixes and the project root away", () => {
    expect(normalizePath("src\\api\\Users.ts")).toBe("src/api/users.ts");
    expect(normalizePath("./src/api/users.ts")).toBe("src/api/users.ts");
    expect(normalizePath("C:/proj/src/a.ts", "C:\\proj")).toBe("src/a.ts");
  });

  it("resolves an absolute path, a suffix and a basename to the same file", async () => {
    const { store } = serverFor("sample-react");
    const loaded = await store.load();
    const path = loaded.summary.files.find((f) => f.includes("/"))!;
    const root = loaded.summary.projectRoot;

    expect(resolveFilePath(loaded.index, root, path).path).toBe(path);
    expect(resolveFilePath(loaded.index, root, `${root}\\${path.replace(/\//g, "\\")}`).path).toBe(path);

    // A suffix resolves when it is unique; when several files share it the
    // caller gets the candidate list instead of an arbitrary winner.
    const suffixOf = (p: string) => p.split("/").slice(-2).join("/");
    const unique = loaded.summary.files.find(
      (f) => f.includes("/") && loaded.summary.files.filter((o) => suffixOf(o) === suffixOf(f)).length === 1,
    );
    if (unique) expect(resolveFilePath(loaded.index, root, suffixOf(unique)).path).toBe(unique);

    const shared = loaded.summary.files.find(
      (f) => f.includes("/") && loaded.summary.files.filter((o) => suffixOf(o) === suffixOf(f)).length > 1,
    );
    if (shared) {
      const ambiguous = resolveFilePath(loaded.index, root, suffixOf(shared));
      expect(ambiguous.path).toBeUndefined();
      expect(ambiguous.candidates).toContain(shared);
    }
  });
});

describe("clarifydoc MCP tools — csharp fixture (route attribute layer)", () => {
  const { server } = serverFor("sample-csharp-api");

  it("routes print versions, auth and parameter bindings, and the body schema on request", async () => {
    const { text } = await call(server, "clarifydoc_routes", { path: "/Users", method: "POST", schema: true });
    expect(text).toContain("versions: 2");
    expect(text).toContain("auth: policy Policies.UsersRead; roles Admin, UserManager; scheme Bearer");
    expect(text).toContain("params: dto: CreateUserDto ← body");
    expect(text).toContain('body: {"type":"object","properties":{"requestedBy"');
    expect(text).toContain('"email_address":{"type":"string"}');
    expect(text).toContain('"required":["name"]');
  });

  it("a deprecated version and an anonymous override are called out", async () => {
    const { text } = await call(server, "clarifydoc_routes", { path: "/Users/{id}", method: "DELETE" });
    expect(text).toContain("versions: 1 (deprecated), 2");
    expect(text).toContain("auth: anonymous (AllowAnonymous)");
  });

  it("the project filter narrows to a sub-project and names it in the miss", async () => {
    const hit = await call(server, "clarifydoc_routes", { project: "root", limit: 100 });
    expect(hit.text).toMatch(/# Routes \(\d+ matches\)/);
    const miss = await call(server, "clarifydoc_routes", { project: "no-such-service", method: "GET" });
    expect(miss.text).toContain("project");
    expect(miss.text).toContain("clarifydoc_routes without `project`");
  });
});

describe("clarifydoc MCP tools — attribute-layer queries (csharp fixture)", () => {
  const { server } = serverFor("sample-csharp-api");

  it("routes filter by policy, role, scheme, anonymous, version, deprecated and body type", async () => {
    const policy = await call(server, "clarifydoc_routes", { policy: "UsersRead", limit: 100 });
    expect(policy.text).toMatch(/# Routes \(4 matches\)/);
    const role = await call(server, "clarifydoc_routes", { role: "UserManager" });
    expect(role.text).toContain("# Routes (1 match)");
    expect(role.text).toContain("POST /api/v{version}/Users");
    const anonymous = await call(server, "clarifydoc_routes", { anonymous: true });
    expect(anonymous.text).toContain("# Routes (2 matches)");
    expect(anonymous.text).toContain("DELETE /api/v{version}/Users/{id}");
    // Its own [AllowAnonymous] waives the [Authorize] it inherits from BaseApiController.
    expect(anonymous.text).toContain("POST /api/Reports/run");
    const guarded = await call(server, "clarifydoc_routes", { anonymous: false, limit: 100 });
    // Routes with no auth at all are neither; GET /api/Reports/{reportId} is
    // guarded only by the [Authorize] it inherits.
    expect(guarded.text).toMatch(/# Routes \(4 matches\)/);
    expect(guarded.text).toContain("GET /api/Reports/{reportId}");
    const v1 = await call(server, "clarifydoc_routes", { version: "1.0", limit: 100 });
    expect(v1.text).toMatch(/# Routes \(3 matches\)/); // POST is v2 only
    const deprecated = await call(server, "clarifydoc_routes", { deprecated: true, limit: 100 });
    expect(deprecated.text).toMatch(/# Routes \(3 matches\)/);
    const body = await call(server, "clarifydoc_routes", { bodyType: "CreateUserDto", limit: 100 });
    expect(body.text).toMatch(/# Routes \(2 matches\)/);
    const miss = await call(server, "clarifydoc_routes", { scheme: "no-such-scheme", method: "GET" });
    expect(miss.text).toContain("clarifydoc_routes without `scheme`");
  });

  it("search finds a route by its policy and shows the guard on the row", async () => {
    const { text } = await call(server, "clarifydoc_search", { query: "UsersRead", kinds: ["route"] });
    expect(text).toContain("[route]");
    expect(text).toContain("auth: policy Policies.UsersRead");
  });

  it("contract renders one endpoint as an OpenAPI-shaped operation with security, parameters and body schema", async () => {
    const { text, isError } = await call(server, "clarifydoc_contract", { path: "/api/v{version}/Users", method: "POST" });
    expect(isError).toBe(false);
    expect(text).toContain("# POST /api/v{version}/Users → Create");
    expect(text).toContain("guards: Authorize(");
    const json = JSON.parse(text.split("```json")[1]!.split("```")[0]!);
    expect(json).toMatchObject({
      operationId: "Create",
      security: [{ Bearer: ["Admin", "UserManager"] }],
      "x-policies": ["Policies.UsersRead"],
      "x-api-versions": ["2"],
    });
    expect(json.requestBody.content["application/json"].schema).toMatchObject({ type: "object", required: ["name"] });
    expect(json.requestBody.content["application/json"].schema.properties.email_address).toEqual({ type: "string" });
    // Path parameters come from the route's params, typed and required.
    const byId = await call(server, "clarifydoc_contract", { path: "/api/v{version}/Users/{id}", method: "GET" });
    const op = JSON.parse(byId.text.split("```json")[1]!.split("```")[0]!);
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer" }, "x-inferred": true },
      { name: "version", in: "path", required: true, schema: {}, "x-inferred": true }, // the v{version} segment
    ]);
    expect(op.deprecated).toBeUndefined(); // serves v1 (deprecated) AND v2
  });

  it("contract lists the candidates when the path is ambiguous, and misses point elsewhere", async () => {
    const many = await call(server, "clarifydoc_contract", { path: "/Users" });
    expect(many.text).toMatch(/# \d+ endpoints match "\/Users"/);
    expect(many.text).toContain("narrow with method, project, file or version");
  });
});

describe("clarifydoc MCP tools — delphi fixture (entry forms)", () => {
  const { server, store } = serverFor("sample-delphi");
  let loaded: LoadedAnalysis;
  beforeAll(async () => {
    loaded = await store.load();
  });

  it("screens entry=true lists only the startup forms, the main form first", async () => {
    const startup = (loaded.summary.screens ?? []).filter((s) => s.startup);
    expect(startup.length, "fixture's .dpr should create forms at startup").toBeGreaterThan(0);
    const main = startup.find((s) => s.startup === "main")!;
    const { text } = await call(server, "clarifydoc_screens", { entry: true });
    const listed = (loaded.summary.screens ?? []).filter((s) => text.includes(`(${s.filePath})`));
    expect(listed.map((s) => s.filePath).sort()).toEqual(startup.map((s) => s.filePath).sort());
    expect(text.indexOf(`(${main.filePath})`)).toBeLessThan(Math.min(...listed.filter((s) => s !== main).map((s) => text.indexOf(`(${s.filePath})`)), Infinity));
    expect(text).toContain("startup: main");
  });
});

describe("clarifydoc_explain — backend fixture", () => {
  const { server } = serverFor("sample-backend");

  it("packs a route's contract, what it reaches and its risk, in that order", async () => {
    const r = await call(server, "clarifydoc_explain", { subject: "GET /api/users/:id" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^# GET \/api\/users\/:id — /);
    const order = ["## Contract and callers", "## What it reaches", "## Risk"].map((h) => r.text.indexOf(h));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.text).not.toMatch(/^Next: /m);
  });

  it("asks which route when a path names several, and names what did not fit", async () => {
    const many = await call(server, "clarifydoc_explain", { subject: "/api/users" });
    expect(many.text).toMatch(/matches \d+ routes — pick one/);
    expect(many.text).toContain('clarifydoc_explain subject="GET /api/users"');
    const reaches = await call(server, "clarifydoc_explain", { subject: "GET /api/users/:id" });
    expect(reaches.text).toMatch(/## What it reaches\n\n(?!No call-graph)/);
  });

  it("explains a function by its source and callers", async () => {
    const r = await call(server, "clarifydoc_explain", { subject: "getUserById" });
    expect(r.text).toMatch(/## Source/);
    expect(r.text).toMatch(/## Callers/);
  });
});

describe("clarifydoc_explain — a budget it overflows", () => {
  const { server } = serverFor("sample-fullstack-cqrs");

  it("cuts to maxTokens and names the calls for the rest", async () => {
    const r = await call(server, "clarifydoc_explain", { subject: "GET /Owners", maxTokens: 500 });
    expect(Math.ceil(r.text.length / 4)).toBeLessThanOrEqual(500 + 120);
    expect(r.text).toMatch(/Next \(did not fit maxTokens=500\):\n- clarifydoc_/);
  });
});
