# ClarifyDoc

Extract a structured, versioned map of any codebase — **frontend route → API endpoint → database** — straight from source, no AI required.

ClarifyDoc parses a repo (or a folder of repos) with tree-sitter / regex extractors and produces per-file JSON plus a project-wide summary: routes, call traces, data access, an entity-relationship model, dependency and blast-radius graphs, and an interactive HTML report. Everything it extracts is content-hashed so you can tell exactly what changed between runs.

**Documentation:** [CLI reference](docs/cli-reference.md) — every command and option ·
[Reading the output](docs/reading-the-output.md) — what each file holds, how it is encoded, and how to query it.

## Why

The goal is to answer questions like *"which screen calls this endpoint, and which table does that endpoint write to?"* — across a **monolith** or **multiple repositories** — without reading the code by hand. ClarifyDoc builds the chain:

```text
Screen / Route  →  handler / service  →  API call / ORM query  →  Entity / Table
   (UI tab)         (Call Traces)         (Data Access)            (Data Model)
```

## The three layers

ClarifyDoc is built as layers, each one optional and additive:

| Layer | What it does | Needs |
|-------|--------------|-------|
| **1 — Deterministic extraction** | Routes, imports/exports, functions, classes, data sources & mutations, ORM entities & relations, interactive elements, screens, complexity, security. Pure static analysis. | tree-sitter / regex only |
| **2 — LSP enhancement** *(optional)* | Resolves cross-file calls the text linker missed by running real language servers in Docker (`textDocument/definition` + `references`). | Docker |
| **3 — AI enrichment** *(roadmap)* | Adds to — never replaces — the layer-1/2 structure: derives **user stories** and end-to-end **flows** from the extracted graph. | LLM |

Layer 1 always runs and is fully self-contained. Layers 2 and 3 only *augment* the same data model, so the base extraction stays trustworthy and reproducible.

## Versioning by content hash

Every analyzed file is tracked in `manifest.json` by **SHA-256 of its contents** plus an `EXTRACTOR_VERSION` stamp. This makes change-tracking explicit:

- `--incremental` reuses cached per-file JSON for files whose hash is unchanged (mtime fast-path, hash slow-path — survives branch switches and sync tools that bump mtime).
- Bumping `EXTRACTOR_VERSION` invalidates the whole cache, so a fixed extractor never leaves stale JSON behind.
- Per-file output carries `analyzedAt`; the project summary records framework/LSP provenance and per-link `confidence` (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`).

## Install

```bash
npm install
npm run setup
npm run build
```

`npm run setup` builds the Pascal and Kotlin tree-sitter grammars, the only two
whose npm packages ship C sources instead of a prebuilt WASM — it needs Docker
running (for emscripten) and takes about a minute. Skipping it leaves Pascal/Delphi
and Kotlin parsing broken. `.npmrc` sets `ignore-scripts`, since the grammar
packages' native `node-gyp` builds are never loaded by the WASM parser.

`npm run build` produces `dist/cli.js`, which is what the `clarifydoc` bin points at — it must exist before any of the invocations below.

### Run with npx

Once the package is published to npm, no install or clone is needed at all:

```bash
npx clarifydoc analyze ./my-app --html   # always the latest published version
npx clarifydoc@0.5.0 analyze ./my-app    # pin a version (recommended in CI)
npx --yes clarifydoc report ./.clarifydoc/my-app   # --yes skips the install prompt in CI
```

Until it is published (or when working against a local checkout), point npx at the clone instead — it resolves the package from the folder and runs the same bin:

```bash
# from inside the repo root
npx . analyze ./my-app --html

# from anywhere, using the path to the clone
npx /path/to/clarifydoc analyze ./my-app --html
```

For a persistent `clarifydoc` command on your PATH during development, use a link instead of npx:

```bash
npm link        # once, inside the repo root
clarifydoc analyze ./my-app --html
```

Every `clarifydoc <command>` example in this README works with any of these forms — just replace `clarifydoc` with `npx clarifydoc`, `npx .`, or the linked command.

## Usage

### Analyze a project

```bash
clarifydoc analyze <path> [options]
```

Output is written to `<output>/<project-name>/` (default `.clarifydoc/<project-name>/`, with `<output>` resolved
against the current directory). What each file in it holds is described in
[Reading the output](docs/reading-the-output.md).

When that directory is inside the project, ClarifyDoc writes a `.gitignore` containing `*` into it, so the analysis
ignores itself — nothing appears in `git status` and your own `.gitignore` is never touched. Empty that file to commit
the analysis instead, so teammates and CI agents get the map without scanning; it is only written when absent.
`.clarifydoc/` is also excluded from discovery, so a scan never eats its own output.

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output <dir>` | Output directory | `.clarifydoc` |
| `--include <globs...>` | Analyze only files matching these patterns (replaces the default set) | all supported |
| `--exclude <globs...>` | Additional file patterns to exclude | — |
| `--max-files <n>` | Max files to analyze | unlimited |
| `--pretty` / `--no-pretty` | Pretty-print JSON | `--pretty` |
| `--verbose` | Show per-step progress | false |
| `--dry-run` | List files without analyzing | false |
| `--no-lsp` | Disable LSP-based symbol resolution | LSP on |
| `--lsp-timeout <ms>` | LSP server startup timeout | — |
| `--incremental` | Reuse cached analysis for unchanged files (mtime + SHA-256) | false |
| `--no-git-history` | Skip git churn/hotspot collection | history on |
| `--stable-output` | Fixed timestamp + relative root, for byte-identical committed analyses | false |
| `--html` | Generate + open an HTML report afterwards | false |
| `--osv` | Check each installed package version (from its lockfile, or an exact declared version) against [OSV](https://osv.dev) and record known advisories — the analysis's only network call | off |
| `--sarif <file>` | Also write the security findings as SARIF 2.1.0 (one rule per category, tagged with its CWEs) — for GitHub code scanning | — |

All options, with examples: [CLI reference → analyze](docs/cli-reference.md#analyze).

```bash
# Analyze a React app and open the report
clarifydoc analyze ./my-app --html

# Re-run, reusing unchanged files
clarifydoc analyze ./my-app --incremental

# Only TypeScript, capped at 50 files, compact JSON
clarifydoc analyze ./my-app --include "**/*.ts" "**/*.tsx" --max-files 50 --no-pretty
```

### Other commands

```bash
clarifydoc impact <path>               # What changed files reach: screens, routes, entities, tests to run
clarifydoc lsp-update <analysis-dir>   # Run layer-2 LSP enhancement on an existing analysis
clarifydoc report <analysis-dir>       # (Re)generate the HTML report from project-summary.json
clarifydoc cfg <file> -f <function>    # Draw one function's control flow as Mermaid
clarifydoc cfg <file> --slice <line>   # What can affect the values used at that line (backward slice)
clarifydoc detect <path>               # Print detected languages + frameworks only
clarifydoc schema                      # Print every field of the per-file JSON and project-summary.json
clarifydoc mcp [path]                  # Serve the analysis to an AI agent over MCP (stdio)
```

`lsp-update` writes `lsp-enhancement.json` alongside `project-summary.json`; `report` reads the summary and emits `report.html`.
Every command's options are in the [CLI reference](docs/cli-reference.md).

## Supported languages

ClarifyDoc has two extraction paths. **Tree-sitter** languages get full AST extraction; **regex** languages get a lighter convention-driven pass.

| Path | Languages (extensions) |
|------|------------------------|
| **tree-sitter** | TypeScript (`.ts`, `.tsx`), JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`), Vue (`.vue`), Svelte (`.svelte`), Python (`.py`, `.pyw`), Java (`.java`), Kotlin (`.kt`, `.kts`), C# (`.cs`), PHP (`.php`), Pascal/Delphi (`.pas`, `.pp`, `.lpr`, `.dpr`, `.dpk`), DFM forms (`.dfm`) |
| **regex** | Go (`.go`), Rust (`.rs`), Ruby (`.rb`), Swift (`.swift`), Dart/Flutter (`.dart`), Lua (`.lua`), Scala (`.scala`), Perl (`.pl`, `.pm`), Visual Basic (`.vb`, `.bas`, `.cls`, `.frm`), C (`.c`), C++ (`.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx`, `.hh`), Objective-C (`.m`, `.mm`), Elixir (`.ex`, `.exs`), Erlang (`.erl`, `.hrl`), Haskell (`.hs`, `.lhs`), Clojure (`.clj`, `.cljs`, `.cljc`), Blazor (`.razor`), HTML pages (`.html`, `.htm`), SQL/DDL (`.sql`, `.ddl`, `.dml`, `.psql`, `.mysql`, `.tsql`, `.plsql`), Prisma schema (`.prisma`) |

A `.vue`/`.svelte` SFC is preprocessed to its `<script>` block; Delphi `.dfm` uses a dedicated parser.

## Multi-project / multi-repo

ClarifyDoc scans for project markers (`package.json`, `*.csproj`/`*.sln`, `*.dpr`, `pom.xml`, `build.gradle[.kts]`, `Cargo.toml`, `go.mod`, `pyproject.toml`/`requirements.txt`, `composer.json`, `Gemfile`, `Package.swift`, `pubspec.yaml`, …) and groups files into **sub-projects**, assigning each file to its innermost enclosing project. A repo with a Delphi client next to a .NET service next to a React frontend is analyzed as one graph with three sub-projects — so cross-tier links (frontend → backend → DB) survive even across language and project boundaries.

## What it extracts

### Per file — `<file>.json`

| Field | Description |
|-------|-------------|
| `imports` / `exports` | Module specifiers, named/default/namespace/type flags; export kinds |
| `functions` / `classes` | Params, return types, decorators, async; methods, properties, inheritance, visibility |
| `calls` (per function) | Classified `internal` / `cross-file` / `api-call` / `database`, with `confidence` |
| `routes` | API + frontend routes: method, handler, middleware, component target |
| `dataSources` | Reads: API calls, state, props, context, env vars, DB/ORM queries (with resolved `entity`), message-queue publish/consume (RabbitMQ, Kafka, amqplib, pika, Spring AMQP, php-amqplib) |
| `dataMutations` | Writes: setState, dispatch, assignments, ref mutations, DB writes |
| `entityRelations` | ORM associations between entities (cardinality, foreign key, join table) |
| `subComponents` / `templateTree` | Child components used, and the real nested template tree (with loop flags) |
| `interactiveElements` / `events` | UI interaction points (onClick/@click, v-model, onSubmit, …) and emitted events |
| `typeReferences` | Type-position uses of classes/interfaces (extends, params, returns, fields, casts, `new`) |
| `complexities` / `securityIssues` | Per-function cyclomatic complexity; per-file security findings |
| `frameworks` / `projectId` | Frameworks this file uses; the sub-project it belongs to |

### Project summary — `project-summary.json`

- `subProjects` + `fileProjects` — detected projects and file→project map
- `detectedFrameworks` — with confidence and detection source
- `componentGraph` / `linkGraph` — file→file dependencies, weighted by **proximity** (1 tight / 2 medium / 3 loose)
- `symbolLinks` — resolved call→definition traces (`resolvedBy: text | lsp`, with `confidence`)
- `routeMap` / `apiCalls` / `screens` — aggregated routes, outbound HTTP calls, screen trees
- `apiRouteLinks` — cross-tier joins: frontend `api-call` URLs matched to backend routes by HTTP method + structurally normalized path (these are what stitch screen→API→DB traces across sub-projects)
- `entityGraph` — ER model (entities/tables/enums + crow's-foot relationships); tables referenced only by raw queries get synthesized `inferred` entities so query-builder codebases still get a data model
- `dataAccessGraph` — file → entity → datastore graph with per-call detail; message queues appear as first-class nodes with publish/consume edges
- `externalPackages` — declared-vs-used external dependency inventory across 19 package ecosystems
- `deployment` — docker-compose-derived topology: services, externals, and service→service edges inferred from env-var evidence (shared API-key vars, connection strings, URL/issuer vars)
- `migrations` — detected ORM/DB migrations (Prisma, TypeORM, Sequelize, Rails, Django, EF Core, GORM, Diesel, Doctrine, Flyway, Alembic)
- `classGraph` / `blastRadius` — class dependency graph and per-file/per-class change impact
- `patterns` / `duplicates` / `layerViolations` / `complexity` / `securityIssues` — code quality
- `healthScore` / `suggestions` — graded health + prioritized actions
- `communities` / `cohesion` / `godNodes` / `surprisingConnections` / `suggestedQuestions` — topology insights
- `confidenceCounts` / `lspStats` — provenance and LSP run stats

**On-disk encoding.** To avoid spelling every file path and code element dozens of times, the artifact is *normalized* (`schemaVersion: 2`) around two registries:

- `files[]` is the **file registry** — a file's `page_id` is its index in this array. Every section that references a file (`componentGraph`, `linkGraph`, `routeMap`, `communities`, `godNodes`, the `fileProjects`/`fileLayerMap` keys, the analysis lists, …) stores that integer page_id instead of the path.
- `elements[]` is the **symbol registry** (`file::symbol` ids) — `symbolLinks`, `complexity`, `classGraph`, `blastRadius`, `dataAccessGraph` reference it by index.

Reconstruct the path-based, in-memory shape with `denormalizeProject(JSON.parse(raw))` (exported from `clarifydoc`). It is shape-detecting, so summaries written before this encoding still load. [Reading the output](docs/reading-the-output.md#four-rules-that-apply-to-every-file) lists which field points into which registry, with `jq` recipes that resolve them.

## Interactive report

`--html` (or `clarifydoc report <dir>`) emits a single self-contained `report.html` — the React + D3 viewer bundled into one offline-capable file, with the analysis payload embedded gzip+base64 (roughly 10× smaller than raw JSON). Tabs:

**Overview · Screens & UI · Call Traces · Architecture · Data Model · Routes · Dependencies · Health · Blast Radius · Patterns · Security · Complexity · Suggestions · Insights**

Tabs hide themselves when there's no data for them. Highlights:

- **Architecture** is a C4-style drill-down — System Context → Deployment (docker-compose topology) → Projects → Components → Code — with dagre-layered layout, plus Data Models and Data Access graph modes.
- **Call Traces** walks click → handler → service → API route → entity, including transitive data access ("this controller reaches these tables via its callees").
- **Data Model** renders entities as full ER tables with crow's-foot relationship edges.

## MCP server — for AI agents

`clarifydoc mcp` serves the analysis over the [Model Context Protocol](https://modelcontextprotocol.io) on stdio, so
an agent can *ask* for the code map instead of grepping for it. Every answer comes from the same analysis the HTML
report renders, with `path:line` references it can open.

```bash
# In the project: serves it, analyzing once if it has never been analyzed
clarifydoc mcp

# Or name it explicitly, and/or an exact analysis directory
clarifydoc mcp ./my-app --analysis-dir ./my-app/.clarifydoc/my-app

# Claude Code — one entry that works in every project you open
claude mcp add clarifydoc --scope user -- clarifydoc mcp
```

Or, in a config file (Claude Code, Cursor, Windsurf, …):

```json
{
  "mcpServers": {
    "clarifydoc": {
      "command": "clarifydoc",
      "args": ["mcp"]
    }
  }
}
```

With no path, the server serves the project containing the client's working directory — walking up to the nearest
`.git` or manifest, so it maps the whole project even when launched in a subdirectory — and reads
`<root>/.clarifydoc/<name>`, where `clarifydoc analyze` and the VS Code extension both write. That is why the config
needs no paths and never goes stale.

If the project has never been analyzed, the server runs one analysis itself so the agent is useful immediately. An
advisory lock in the analysis directory means only one process ever writes it: a second run waits for the first
instead of interleaving with it.

| Tool | Answers |
|------|---------|
| `clarifydoc_status` | What has been mapped, how stale it is, how much of each dimension exists |
| `clarifydoc_search` | Find a route / screen / symbol / entity / file by name — one list, ranked, terms matched independently |
| `clarifydoc_routes` | API + frontend routes, their handlers, their frontend callers, what they reach |
| `clarifydoc_screens` | Screens/pages, their routes, the endpoints they call, the dialogs they open |
| `clarifydoc_file` | Everything about one file: functions, complexity, data access, callers, findings |
| `clarifydoc_trace` | Callers/callees of a symbol, N hops, plus the data effects it reaches |
| `clarifydoc_blast_radius` | What breaks if a file changes — dependents, screens/routes/entities reached |
| `clarifydoc_data_model` | Entities/tables, columns, relations, and the functions that read/write them |
| `clarifydoc_data_flows` | Route/screen → data effect rows (e.g. which endpoints reach a DB write) |
| `clarifydoc_health` | Score plus security, layer violations, complexity, duplicates, hotspots |
| `clarifydoc_impact` | Impact of the current git diff: screens, routes, entities, tests to run |
| `clarifydoc_analyze` | Re-run the analysis (incremental). The only tool that writes anything |

Flags: `--analysis-dir <dir>` to read an exact analysis directory, `--no-auto-analyze` to forbid re-analysis on
request (the first analysis still runs), `--no-cold-start` to forbid even that, plus the `analyze` filters
(`--include`, `--exclude`, `--max-files`, `--lsp`, `--no-git-history`) for the scans it does run.

Inside VS Code the extension publishes this server for you, per workspace folder, and **ClarifyDoc: Set Up MCP for
an AI Agent…** writes the config for Claude Code, Cursor or Windsurf — pointed at a launcher that survives extension
updates. See [clarifydoc/vscode](https://github.com/clarifydoc/vscode).

## Detection details

### Frameworks

**Web / app**: React, React Router, Next.js, Expo Router, Vue, Vue Router, Nuxt, Svelte, SvelteKit, Angular, Express, NestJS, Fastify, FastAPI, Django, Flask, ASP.NET, Blazor, Spring Boot/Web, Ktor, Android, CodeIgniter, Flutter, Pinia, Vuex, Redux, React Query.

**Message queues** (surface as publish/consume data sources and queue nodes in the data-access graph): RabbitMQ (`RabbitMQ.Client`, amqplib, pika, php-amqplib, Spring AMQP), Kafka (kafkajs, Spring Kafka).

**ORMs / query builders** (surface as `kind="database"` data sources + entity graph):

| Ecosystem | ORMs |
|-----------|------|
| .NET / C# | Entity Framework Core, EF 6, Dapper, NHibernate, raw ADO.NET |
| JS / TS | Prisma, TypeORM, Sequelize, Drizzle, MikroORM, Mongoose, Knex, Objection.js |
| Python | SQLAlchemy, Django ORM, Tortoise, Peewee |
| Java / Kotlin | Hibernate, Spring Data JPA, MyBatis, jOOQ, Exposed |
| Ruby | Active Record, Sequel |
| PHP | Doctrine, Eloquent, CodeIgniter Query Builder |
| Go | GORM, sqlx, Ent |
| Rust | Diesel, SeaORM, SQLx |
| Dart | Firestore, sqflite, Supabase |
| Raw SQL | `.sql` / `.ddl` files |

Detection reads `package.json`, `.csproj` `PackageReference`, `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`, `pom.xml`, `build.gradle[.kts]`, `requirements.txt`, `pyproject.toml`, `pubspec.yaml`.

### Routes

Express/Fastify (`app.get("/path", h)`), decorators/annotations (`@Get()`, `@RequestMapping`, `@app.route`), React Router (`<Route path=… />`, including nested-route prefix composition), Vue Router config objects, Next.js, Nuxt, SvelteKit & Expo Router file-based routing (also when the app sits in a sub-folder), Spring (`@GetMapping`/`@PostMapping`), Ktor DSL, ASP.NET attributes, Blazor `@page`, CodeIgniter convention routing (controller file + public method → URL), Dart `shelf_router` + Flutter GoRouter, and plain multi-page HTML sites (each page becomes a frontend route with its links and forms).

### SQL / DDL

`.sql` files are parsed into the same model: `CREATE TABLE/VIEW/INDEX/SEQUENCE/TYPE` → classes (typed columns), `CREATE PROCEDURE/FUNCTION/TRIGGER` → functions, DML/`EXEC`/`CALL` → data sources, `FOREIGN KEY … REFERENCES` → entity-graph edges. Dialects (best effort): PostgreSQL, MySQL, T-SQL, Oracle PL/SQL, SQLite; bracketed, double-quoted and backtick identifiers all recognized.

## Programmatic API

```typescript
import { analyze } from "clarifydoc";

const result = await analyze({
  projectRoot: "./my-app",
  outputDir: ".clarifydoc/my-app",
  pretty: true,
  incremental: true,
});
// per-file FileAnalysis JSON + project-summary.json written to outputDir
```

Key exports (see [src/index.ts](src/index.ts)):

```typescript
export { analyze } from "./core/analyzer.js";
export { discoverFiles } from "./core/file-discovery.js";
export { detectFrameworks, gatherProjectInfo } from "./core/framework-detector.js";
export { generateHtmlReport } from "./core/html-report.js";
export { parseSource, parseFile, runQuery } from "./parsers/parser-manager.js";
export type * from "./types/analysis.js";
```

## Project configuration

Optional, committed with the code: `.clarifydoc/config.json` (next to `.clarifydoc/ignore`). Everything in it has a default; a missing file changes nothing, and a bad value is reported as a warning and ignored rather than failing the run.

```json
{
  "$comment": "Why we changed these: legacy module is being strangled, tolerate more churn.",
  "layers": [
    { "layer": "data",     "patterns": ["src/Persistence/**", "**/*Repository.cs"] },
    { "layer": "services", "patterns": ["src/Application/**"] },
    { "layer": "ui",       "patterns": ["src/Web/**", "frontend/src/**"] }
  ],
  "exempt":    ["tools/**", "prototypes/**"],
  "generated": ["**/*.generated.*", "src/api/gen/**"],
  "rules": [
    { "name": "billing stays out of payroll", "from": "features/billing/**", "to": "features/payroll/**", "except": ["**/shared/**"] },
    { "name": "domain is pure", "from": "src/Domain/**", "to": "src/Infrastructure/**", "severity": "warn" }
  ],
  "refactorPressure": {
    "weights":  { "complexity": 0.25, "size": 0.1, "responsibility": 0.2, "coupling": 0.2, "churn": 0.25 },
    "ceilings": { "maxCognitive": 50, "loc": 800, "concerns": 4, "fanIn": 15, "fanOut": 15, "commits": 30 },
    "bands":    { "observe": 25, "suggest": 45, "strong": 60, "urgent": 75 },
    "gates":    { "godClassLoc": 500, "godClassCognitive": 120, "concernOverload": 4, "hubFanIn": 10, "hubFanOut": 10 }
  }
}
```

`layers` assigns architecture layers by glob (`ui`, `components`, `services`, `data`, `utils`, `config`), checked in order **before** the built-in path heuristics — the way to fix a layer the heuristics get wrong for your repo (an `adapters/` folder that is infrastructure here and UI glue there). `exempt` marks trees outside the layered application (tooling, scripts, prototypes) so they are never a layer-violation source or target; tests are always exempt. `generated` marks generated code by glob; it is excluded from every quality signal (patterns, duplicates, violations, refactor pressure, the health grade), extending the automatic detection of generated barrel trees. Globs use the ignore-file dialect (`*`, `**`, `?`) and match the posix project-relative path. Anchoring follows gitignore: a pattern carrying a `/` (`/dist`, `src/db/**`) is fixed to the project root, while a slash-less one (`dist`, `*.generated.ts`) also matches a bare file name anywhere.

`rules` are your own import rules: a file matching `from` must not import a file matching `to` (one glob or a list on each side; `except` lifts the rule for the files it names on either end; `severity` is `error` unless it says `warn`). Each breach is reported among the layer violations with the rule's name — the Health tab and `clarifydoc_health` category `layers`.

`refactorPressure` tunes the composite **refactor pressure** score (`project-summary.json` → `refactorPressure`, MCP `clarifydoc_health` category `pressure`): each file's cognitive complexity, size, mixed concerns, coupling and git churn are normalized against the `ceilings`, combined with the `weights`, and cut into `bands`. `gates` fire regardless of the score. Every row lists the drivers behind it and a `confidence` equal to the share of signal that was available, so a run without git history says so instead of scoring lower.

## Default ignores

Always excluded:

```text
node_modules, dist, build, out, .git, bin, obj,
__pycache__, .venv, venv, vendor, target, Pods,
*.min.js, *.bundle.js, *.d.ts
```

Beyond those, a `.clarifydocignore` at the project root or a `.clarifydoc/ignore` next to the analysis excludes
further paths in gitignore syntax — `*`, `**`, `?`, `[abc]`, `#` comments, and `!` to re-include. A pattern carrying
a `/` is anchored to the directory the ignore file sits in, so `/dist` drops the build directory at the root and
leaves `src/dist/` alone; a slash-less pattern such as `vendor` matches that name at any depth. The last matching
pattern decides, and unlike git a file can be re-included even when its parent directory was excluded, so
`src/**` followed by `!src/important.ts` keeps that one file.

Files whose names look like credentials (`.env`, key/secret-like names) are skipped and reported under `skippedSensitive`.

## How accurate is it?

ClarifyDoc is measured on real repositories checked out at pinned commits: it analyzes them, serves the result over
the MCP server and scores it against labels **written by hand from the source** — never against
ClarifyDoc's own output. Over seven pinned repositories (Rails + Vue, ASP.NET + Angular, Django + Angular, FastAPI + Nuxt,
Go + Vue, Express + React, FastAPI), as of extractor 1.117:

| | |
|---|---|
| Cross-tier links (frontend call → backend route), sampled calls on five repos | precision **0.993**, recall **0.953** |
| Data access (file → table) | F1 **1.000** |
| Route paths, as a caller would request them | F1 **1.000** |
| Route declaration sites found | F1 **1.000** |
| Search (Mean Reciprocal Rank) | **1.000** |
| Answering through the map vs. reading the files | **69%** fewer tokens |

Bad numbers get published too: a corpus picked to flatter the tool measures nothing. The first run
scored route paths at 0.000 on FastAPI and missed every DELETE call in the RealWorld frontend.

## License

MIT — see [LICENSE](LICENSE). Security reports: [SECURITY.md](SECURITY.md).
