# Reading the output

What `clarifydoc analyze` writes, how the files are encoded, and how to get answers out of them — in the
report, with `jq`, or from code. For the commands and their options, see the [CLI reference](cli-reference.md).

The examples come from a small system of five services: a Vite frontend (`web`), a YARP gateway, two
ASP.NET APIs (`orders`, `inventory`) and a Java client (`billing`), run together by a docker-compose file.

- [The console summary](#the-console-summary)
- [The output directory](#the-output-directory)
- [Where to look for an answer](#where-to-look-for-an-answer)
- [Four rules that apply to every file](#four-rules-that-apply-to-every-file)
- [Per-file JSON](#per-file-json)
- [project-summary.json](#project-summaryjson)
- [Following one request end to end](#following-one-request-end-to-end)
- [Why a link exists — and why one doesn't](#why-a-link-exists--and-why-one-doesnt)
- [The other files](#the-other-files)
- [Recipes](#recipes)
- [Reading it from code](#reading-it-from-code)

## The console summary

```text
Done. Analysis complete.
  Files:         16            source files analyzed — one per-file JSON each
  Elements:       0 interactive  buttons, inputs, forms and links with a handler (interactiveElements)
  Screens:        0            pages, views, forms and dialogs (screens)
  Routes:        10            API and frontend routes (routeMap)
  Links:          6            file → file dependency edges (linkGraph)
  Traces:        30            call → definition links, including the HTTP hops (symbolLinks)
  Health:         A            healthScore.grade, A–F
  Patterns:       0            design patterns and smells: god objects, long files, factories … (patterns)
  Security:       0 issue(s)   securityIssues
  Suggestions:    3            prioritized actions (suggestions)
  Output: /home/me/src/shop/.clarifydoc/shop
```

`Files` counts source files only. Build manifests and config files (`package.json`, `pom.xml`,
`appsettings.json`, compose files) are read for frameworks, packages and service addresses, but get no
per-file JSON of their own.

## The output directory

```text
.clarifydoc/shop/
├── project-summary.json      the whole project, linked — start here
├── <source path>.json        one per analyzed file: orders/Controllers/OrdersController.cs.json, …
├── report-data.json          the report viewer's input
├── report.html               the interactive report (--html, or `clarifydoc report`)
├── manifest.json             content hashes for --incremental
├── impact-latest.json        what changed since the previous --incremental run
├── lsp-enhancement.json      links added by language servers (lsp-update)
├── lsp-ground-truth.json     every language-server query and its raw answer
└── .gitignore                `*` — keeps the analysis out of git (only when it sits inside the project)
```

| File | Written by | Read it when |
|------|------------|--------------|
| `project-summary.json` | every `analyze` | You want anything that spans files: routes, who calls them, what they reach, the data model, risk, quality. |
| `<path>.json` | every `analyze` | You want everything extracted from one file, before any cross-file linking. |
| `report.html` | `analyze --html`, `report` | You want to look rather than query. One self-contained file. |
| `report-data.json` | every `analyze` | Rarely — it is a subset of the summary shaped for the viewer, and its format follows the viewer. |
| `manifest.json` | `analyze --incremental` | You want to know which version of which file the analysis saw. |
| `impact-latest.json` | `analyze --incremental`, from the second run | You want the effect of the latest change set. |
| `lsp-enhancement.json` | `lsp-update` | Almost never directly — `report` and `mcp` merge it for you. |
| `lsp-ground-truth.json` | `lsp-update`, `analyze` with LSP | You are measuring the text linker against a language server. |

## Where to look for an answer

| Question | In the report | In `project-summary.json` |
|----------|---------------|---------------------------|
| What endpoints does this project serve? | Routes | `routeMap` |
| Which screen or file calls this endpoint? | Routes, Call Traces | `apiRouteLinks`, `symbolLinks` with `relation: "http"` |
| What does this endpoint end up touching? | Call Traces | `dataFlows`, `symbolReach` |
| Which function reads or writes this table? | Data Model | `symbolDataAccess`, `dataAccessGraph` |
| What tables exist, and how do they relate? | Data Model | `entityGraph`, `migrations` |
| Which outbound calls go where, and why do we think so? | Routes | `apiCalls[].origin` |
| Which services depend on which? | Architecture | `projectDependencies`, `deployment` |
| What breaks if I change this file? | Blast Radius | `blastRadius`, or `clarifydoc impact` |
| Where should we refactor first? | Health, Complexity | `refactorPressure`, `hotspots`, `complexity` |
| Is anything dead? | Health | `deadCode`, `unusedFiles` |
| Are there obvious security problems? | Security | `securityIssues` |
| What third-party packages do we use, and are they used? | Dependencies | `externalPackages` |
| Can I trust this analysis? | Overview | `provenance`, `confidenceCounts`, `apiRouteLinkStats` |

## Four rules that apply to every file

**1. Paths are project-relative and use `/`; lines are 1-based.** `orders/Controllers/OrdersController.cs`,
line 26 — on every platform.

**2. `project-summary.json` stores most references as numbers.** To spell each path and symbol once, the
summary keeps two lookup tables and refers to them by index:

- `files[]` — every analyzed file. A field holding a file stores its index into `files[]` (its *page id*).
- `elements[]` — every symbol the graphs mention, as `{ id, kind?, line?, endLine? }`. The `id` reads
  `<file>::<symbol>`. Graph fields store an index into `elements[]`.

```json
"files":    ["billing/…/CustomerLookup.java", …, "orders/Controllers/OrdersController.cs", …],
"elements": [{ "id": "::ControllerBase", "isExternal": true }, …,
             { "id": "person/…/PersonRepositoryImpl.java::PersonRepositoryImpl.getPerson",
               "kind": "function", "line": 8, "endLine": 13 }, …],
"routeMap": [{ "path": "/api/items", "httpMethod": "GET", "handler": "List", "filePath": 4, … }],
"symbolLinks": [{ "from": 12, "fromLine": 11, "to": 78, "callName": "personRepository.getPerson", … }]
```

`routeMap[0].filePath` is `4`, so the route lives in `files[4]`. The link goes from `elements[12]` (called at
line 11) to `elements[78]`. Which table a field points into:

| Index into `files[]` | Index into `elements[]` |
|----------------------|-------------------------|
| `filePath` on `routeMap`, `apiCalls`, `screens`, `interactiveElements`, `events`, `componentUsage`, `patterns`, `securityIssues`, `suggestions`, `migrations`, `responsibilityProfiles`, `refactorPressure`, `deadCode.files`, `deadCode.exports` | `symbolLinks[].from`, `.to` |
| `source`/`target` on `linkGraph`, `apiRouteLinks`, `surprisingConnections` | `complexity[].file`, `complexity[].functions[].fn` |
| `file` on `symbolDataAccess`, `symbolReach` (and its `effects[].originFile`), `godNodes`, `fileChurn`, `hotspots` | `blastRadius[].file`, `affectedFiles`, `transitiveFiles`, `dependsOn`, `exportedSymbols[].callers[].ref`, `typeUsages[].type` |
| `dataFlows[].entryFile`, `sourceFile`/`targetFile` on `layerViolations` and `componentLaunches`, `duplicates[].occurrences[].filePath`, `unusedFiles[]` | `classGraph` nodes (`el`) and edges (`source`, `target`) |
| The **keys** of `fileProjects`, `fileLayerMap` and `componentGraph`, the values of `componentGraph` and `communities` | `entityGraph` nodes (`ref`) and edges; `dataAccessGraph` nodes (`el`) and edges |

Element ids follow a few shapes:

| `id` | Means |
|------|-------|
| `orders/Clients/InventoryClient.cs::InventoryClient.GetItemAsync` | A function or method — `Class.method`, or the bare name |
| `orders/Controllers/OrdersController.cs::` | The file itself (empty symbol, `kind: "file"`) — what `blastRadius` and `complexity` rows point at |
| `orders/Program.cs::<setup>` | The file's top-level code, as one pseudo-function |
| `orders/Controllers/OrdersController.cs::route:POST /api/orders` | A route's anchor: the first hop of every trace that starts at an endpoint |
| `::ControllerBase` | Not declared in the project (`isExternal: true`): a framework or library type |
| `::db::Person`, `::entity::Person::Person` | Graph nodes with no source file: a datastore, an entity known only from queries |

Everything else in the summary — `httpMethod`, `path`, `projectId`, `confidence` — is stored as written. The
per-file JSON uses none of this: its paths are plain strings. [Reading it from code](#reading-it-from-code)
shows how to get the summary back into plain paths in one call.

**3. Every inferred fact says how sure it is.** Links, relations and type references carry `confidence`:

| Value | Means |
|-------|-------|
| `EXTRACTED` | Stated in the source: an import, an exact name, a literal URL matching one route. |
| `INFERRED` | Derived by a rule: a receiver's declared type, a DI registration, a base URL from config, a transitive hop. Usually right; check the rule (below). |
| `AMBIGUOUS` | Several candidates fit and one was kept, or the evidence disagreed. Treat as a lead, not a fact. |

Most link types also say **why**: `strategy` on a symbol link, `matchedVia` on an API link, `evidence` on a
call's origin. See [Why a link exists](#why-a-link-exists--and-why-one-doesnt).

**4. A missing field means "nothing to report", not zero.** Optional sections are left out when empty, and a
section the analysis could not compute is left out too. `provenance` says which: whether git history was
read (`signals.gitHistory`), whether a language server ran (`signals.lsp`), whether `.clarifydoc/config.json`
was found and what was wrong with it (`config`), and which files fell back from the parser to regex
(`parseFallbacks`).

```json
"provenance": {
  "extractorVersion": "1.87.0", "schemaVersion": 2, "toolVersion": "0.5.0",
  "incremental": false,
  "config": { "present": false, "warnings": [] },
  "signals": { "lsp": "absent", "gitHistory": "disabled" },
  "extractorWarningFiles": 0
}
```

## Per-file JSON

`<output>/<source path>.json` holds what was extracted from one file **on its own**. It is the raw material:
cross-file facts — which function a call reaches, which route serves a URL — are only in the summary.

```json
{
  "filePath": "orders/Controllers/OrdersController.cs",
  "language": "csharp",
  "projectId": "orders",
  "lineCount": 42,
  "routes": [
    { "path": "/api/orders", "httpMethod": "POST", "kind": "api", "handler": "Create",
      "owner": "OrdersController", "line": 26, "middleware": [], "calls": [],
      "params": [{ "name": "request", "type": "OrderRequest", "binding": "body", "inferred": true }] }
  ],
  "dataSources": [
    { "kind": "api-call", "name": "GetAsync", "target": "api/items", "line": 37,
      "baseRef": { "kind": "client", "key": "name:legacy" }, "calls": [] }
  ],
  "classes": [{ "name": "OrdersController", "extends": "ControllerBase",
                "decorators": ["ApiController", "Route(\"api/orders\")"], "methods": [ … ] }],
  …
}
```

| Field | Holds |
|-------|-------|
| `filePath`, `language`, `projectId`, `frameworks`, `lineCount` | What the file is, and which sub-project it belongs to (`"root"` when none). |
| `imports`, `exports` | Module specifiers with their names; exported names with their kind. |
| `functions`, `classes` | Every function and class: parameters with types, return types, decorators **with their arguments**, methods, properties, `extends`/`implements`, and each body's `calls`. |
| `routes` | Endpoints and frontend routes declared here: `httpMethod`, `path`, `handler`, `middleware`, `auth`, `versions`, `params` with where each binds from. A path is as complete as this file alone can tell; the summary's `routeMap` has the final one. |
| `dataSources` | What the file reads or calls: `api-call` (with its `target` URL), `database` (with the `entity` and `access: read/write` when known), `queue-publish`/`queue-consume`, `env`, and UI state (`state`, `prop`, `store`, `context`). |
| `dataMutations` | What it writes: `setState`, `dispatch`, assignments, `db-write`. |
| `entityRelations` | ORM associations declared here: cardinality, foreign key, join table. |
| `screens`, `subComponents`, `templateTree`, `interactiveElements`, `events` | The UI: screens and their component tree, child components, buttons/inputs/forms with their handlers, emitted events. |
| `typeReferences` | Every place a type is used (extends, parameter, field, `new`, cast), for per-class blast radius. |
| `diBindings`, `httpClientRegistrations`, `proxyRules` | Container registrations, HTTP clients with a base URL, dev-server and gateway proxy rules — facts the cross-file pass resolves. |
| `complexities` | Per function: cyclomatic and cognitive complexity, nesting depth, parameter count. |
| `securityIssues` | Findings in this file, with the line and snippet. |
| `extraction` | Present only when the parser failed and the file was read with the regex fallback — expect less detail. |
| `extractorWarnings` | Schema problems in this file's output. Present only when there are some. |

Two things trip people up:

- **`calls[].kind` is the per-file view.** `"_inventory.GetItemsAsync"` reads as `internal` with
  `target: null`, because this file alone cannot see where `_inventory` comes from. Where the call goes is in
  the summary's `symbolLinks` (there: `InventoryClient.GetItemsAsync`, via the constructor-injected field).
- **A route's `path` may still change.** A prefix from a router mount, a base controller or a URL include is
  applied in the cross-file pass. Read paths from `routeMap`.

## project-summary.json

The sections below are grouped by what they answer. Every field is described in full, with comments, in
[src/types/analysis.ts](../src/types/analysis.ts) (`ProjectAnalysis` and the types it uses).

### Scope

| Field | Holds |
|-------|-------|
| `projectRoot`, `analyzedAt`, `provenance` | Where, when, with what, and what the analysis could see. |
| `files`, `elements` | The two lookup tables ([rule 2](#four-rules-that-apply-to-every-file)). |
| `subProjects` | Each detected project: `id`, `root`, `kind` (`node`, `dotnet`, `java-maven`, …), the `markers` that identified it, and its own `frameworks`. The analyzed folder itself is `root`. |
| `fileProjects` | File → sub-project id. |
| `detectedFrameworks` | Frameworks and ORMs, each with `confidence` and the evidence (`detectedVia`). |
| `skippedSensitive`, `skippedSymlinks` | Files left unread because they look like credentials, or because a symlink leaves the project. |
| `confidenceCounts` | How many `symbolLinks` are `EXTRACTED`, `INFERRED` and `AMBIGUOUS`. |

### The chain: screen → API → code → data

| Field | Holds |
|-------|-------|
| `routeMap` | Every route, one row per sub-project + method + path + API version. `kind` is `api` or `frontend`; `prefixUnresolved` names a prefix that could not be read (the `path` is then only the tail); `requestSchema` is the request body as JSON Schema when the handler's parameter type is known; `contract` names the interface operation a typed API route implements. |
| `apiCalls` | Every outbound HTTP call in the code: `target` URL as written, `targetAlternatives` when a helper builds one of several, and `origin` — the service it reaches and the facts that say so. |
| `apiRouteLinks` | Each call matched to the route that serves it: `source`/`sourceLine` → `target`/`targetLine`, `method`, `url`, `routePath`, `handler`, `sourceProject` → `targetProject`, `confidence`, `matchedVia`. `sourceRole: "test"` or `"generated"` marks callers that are not production code. |
| `apiRouteLinkStats` | What happened to every call: linked, refused (and why), unmatched, calls to other hosts. The first place to look when a link you expected is missing. |
| `symbolLinks` | Every resolved call → definition edge: `from`/`fromLine` → `to`, `callName` as written, `confidence`, `strategy`, `relation` (`calls`, `instantiates`, `implements`, `http`, `mq`, `dispatch`, `reference`). The HTTP and message-queue hops are in here too, which is what makes a trace cross a service boundary. |
| `screens` | Screens, pages, forms and dialogs: `name`, `routePath`, `components` (a nested tree with events and data bindings), `navigatesTo`, `startup` (`main` for an app's first window). |
| `interactiveElements`, `events`, `componentUsage`, `componentLaunches` | Every button/input/form with its handler; emitted events; which component renders which; which code opens which dialog. |
| `dataFlows` | Entry point → effect rows: a route or screen (`entryLabel`) that reaches a `db-read`, `db-write`, `db`, `api-call`, `queue-publish` or `queue-consume` on `resource`, `distance` calls away. |
| `symbolReach` | The same, per function: every effect a function reaches, with the function that performs it (`originSymbol`) and how many hops away. |
| `symbolDataAccess` | Database and queue access attributed to the function that does it: `symbol` → `entity`, `datastore`, and the call `sites`. |

### Services and deployment

| Field | Holds |
|-------|-------|
| `projectDependencies` | Sub-project → sub-project runtime edges: `kind` `http` or `bus`, how many links, the endpoints that cross, and the deployment edge that agrees. Import coupling is not here — that is `componentGraph`. |
| `serviceAddresses` | The names each sub-project answers to: compose service names and aliases, published ports, URLs it listens on. |
| `proxyRules` | Dev-server proxies and gateway routes: `pathPrefix` → `target`, `rewriteTo`, who declared it (`via`: `vite`, `yarp`, `ocelot`, …). |
| `deployment` | The topology from compose and Kubernetes files: services with their image, kind (`app`, `datastore`, `queue`, …), ports and the sub-project they run; external infrastructure; service → service edges with the env var that evidences each. |
| `externalPackages` | Every declared third-party dependency: `ecosystem`, `version`, `scope` (`prod`, `dev`, …), the manifest that declares it, and whether code imports it. |

### Data model

| Field | Holds |
|-------|-------|
| `entityGraph` | Entities and tables with their columns, and the relations between them with cardinality on both ends, foreign key and join table. `orm: "inferred"` marks a table known only from queries. |
| `dataAccessGraph` | File → entity → datastore, with the call sites on each edge. Message queues are nodes too. |
| `migrations` | Detected migrations by ORM or tool. |

### Change risk

| Field | Holds |
|-------|-------|
| `blastRadius` | Per file: direct and transitive dependents, `impactScore`, `level` (`low` … `critical`), `changeRisk` (`safe`, `moderate`, `dangerous`), which exported symbols are used where, `traceImpact` (the screens, routes, entities and queues it reaches), `contextBurden` (how much code surrounds it), and a `verdict`: what kind of file it is (`foundation`, `boundary`, `flow`, `shared`, `localized`), how serious a change is for that kind, and the `reasons`. |
| `fileChurn`, `hotspots` | Commits, authors and line churn per file from git; files that are both complex and often changed. Absent without git history. |
| `refactorPressure` | Files ranked by a 0–100 score combining complexity, size, mixed concerns, coupling and churn, with the `drivers` behind each score, the hard `gates` that fired, and a `confidence` that drops when a signal was unavailable. |
| `responsibilityProfiles` | Which boundaries each file touches (database, HTTP, queue, UI, …) and which functions mix them. |

### Structure

| Field | Holds |
|-------|-------|
| `componentGraph` | File → the files it depends on. |
| `linkGraph` | The same edges with a `proximity` (1 tight, 2 medium, 3 loose), the `reason`, and the `calls` behind it. |
| `classGraph` | Class → class dependencies by kind of use: `inheritance`, `data`, `function`. |
| `fileLayerMap`, `layerViolations` | Each file's architecture layer, and imports that go the wrong way. |
| `communities`, `cohesion`, `godNodes`, `surprisingConnections`, `suggestedQuestions` | Clusters of files that belong together, how tight each is, the most connected files, edges worth a second look, and questions generated from all of that. |

### Quality

| Field | Holds |
|-------|-------|
| `healthScore` | `score` 0–100 and `grade` (A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F), the `penalties` that cost points, and every graded `dimension` with its rate. Only authored, non-test code is graded. |
| `complexity` | Per file and per function: cyclomatic and cognitive complexity, nesting depth. `clarifydoc cfg` draws any one of these functions. |
| `patterns` | Design patterns and smells (`god-object`, `long-file`, `singleton`, `factory`, …) with a `confidence`. |
| `securityIssues` | Hard-coded secrets, injection risks, `eval`, debug statements, … with `severity`, line and snippet. |
| `duplicates` | Functions repeated by name or by structure. |
| `deadCode` | Files no entry point reaches and exports nothing imports. `files[].confidence` is `INFERRED` (nothing reaches it) or `AMBIGUOUS` (something names it, so it may be loaded by convention); `deadImporters: 0` marks the top of a dead cluster — the one to delete first. `skippedProjects` lists what was not judged, and why. |
| `generatedRoots`, `unusedFiles` | Detected generated-code trees, and files in them nothing outside imports. |
| `suggestions` | Prioritized actions with their `evidence`. |

## Following one request end to end

The frontend's `placeOrder` posts to `/api/orders`. Start from the call:

```bash
jq '.files as $f | .apiCalls[] | select($f[.filePath] == "web/src/api.ts" and .target == "/api/orders")' \
  project-summary.json
```

```json
{
  "kind": "api-call", "name": "post", "target": "/api/orders", "line": 2, "filePath": 13,
  "origin": {
    "baseRef": { "kind": "literal", "key": "http://localhost:5100" },
    "host": "orders", "project": "orders", "confidence": "EXTRACTED",
    "evidence": [
      { "step": "proxy",   "detail": "/api → http://localhost:5100 (vite)",       "file": "web/vite.config.ts", "line": 7 },
      { "step": "address", "detail": "localhost:5100 → gateway (listen)",         "file": "gateway/Properties/launchSettings.json" },
      { "step": "proxy",   "detail": "/api/orders → http://orders:8080 (yarp)",   "file": "gateway/appsettings.json", "line": 6 },
      { "step": "address", "detail": "orders → orders (service)",                 "file": "docker-compose.yml" }
    ]
  }
}
```

`origin.evidence` is the reasoning, step by step: the Vite dev proxy sends `/api` to port 5100, the gateway
listens there, the gateway forwards `/api/orders` to the `orders` service, and compose says that host is the
`orders` sub-project. Because the origin names a project with `EXTRACTED` confidence, the call may only join
routes that project serves — it can never land on a look-alike `/api/orders` in another service.

Then follow the symbol links from the call onwards. Of the lines this prints, three make up the request
(wrapped here):

```bash
jq -r '.elements as $e | .symbolLinks[]
  | "\($e[.from].id):\(.fromLine)  →  \($e[.to].id)  [\(.relation) via \(.strategy), \(.confidence)]"' \
  project-summary.json
```

```text
web/src/api.ts::placeOrder:2
  →  orders/Controllers/OrdersController.cs::OrdersController.Create              [http via api-route, EXTRACTED]
orders/Controllers/OrdersController.cs::OrdersController.Create:29
  →  orders/Clients/InventoryClient.cs::InventoryClient.GetItemAsync              [calls via injection, INFERRED]
orders/Clients/InventoryClient.cs::InventoryClient.GetItemAsync:14
  →  inventory/Controllers/ItemsController.cs::ItemsController.Get                [http via api-route, EXTRACTED]
```

Read top to bottom, that is the request: the browser hits `POST /api/orders`, its handler
`OrdersController.Create` calls the injected `InventoryClient`, and that client calls
`GET /api/items/{id}` on the inventory service. The middle hop is `INFERRED` because it rests on a rule — the
receiver `_inventory` is a field whose declared type is `InventoryClient` — rather than on a name written at
the call site.

You rarely need to walk the links yourself: `dataFlows` already lists every entry point with what it ends
up touching, `distance` calls away.

```bash
jq -r '.dataFlows[]? | "\(.entryLabel)  →  \(.effect) \(.resource)  (distance \(.distance), \(.confidence))"' \
  project-summary.json
```

```text
POST /api/orders  →  api-call api/items/{id}  (distance 2, INFERRED)
```

In a project with a database, the same rows end at tables:

```text
DELETE /api/users/:id  →  db-write user  (distance 1, INFERRED)
POST /api/auth/login  →  db-read user  (distance 2, INFERRED)
```

## Why a link exists — and why one doesn't

### `symbolLinks[].strategy`

How the linker found the target, grouped by the kind of evidence:

| Strategy | Found by |
|----------|----------|
| `direct` | The exact name in the file the call imports from. |
| `import-file`, `import-dir` | The call's head is an import alias that names one file, or a directory. |
| `class-name`, `constructor` | `ClassName.method` or `new ClassName` through the project's class index. |
| `injection` | The receiver's declared type: a field, constructor or method parameter, or typed local. |
| `di-binding` | A container registration says which implementation the receiver's interface gets. |
| `interface-redirect` | The receiver's declared type is an interface; linked through it to its implementation. |
| `inheritance` | The member is inherited from a parent class. |
| `type-argument` | A generic argument names the class (`AddHttpClient<InventoryClient>()`). |
| `deep-qualified`, `factory-via` | A dotted suffix match, or the factory the receiver was made by. |
| `unique-global`, `unique-global-blind` | The only definition of that name in the project — with supporting evidence, or without. The blind variant is the weakest link there is. |
| `api-route`, `queue` | An HTTP call joined to its route, or a publish joined to its consumer. |
| `route-component`, `route-self`, `route-scan`, `spec-join` | A route anchored to its handler or page component; a spec route (OpenAPI, WSDL, GraphQL) joined to its implementation. |
| `dispatch:<id>` | A framework's indirection, such as `dispatch:mediatr` for a MediatR `Send` reaching its handler. |
| `interface-fanout`, `reference` | Navigation only: interface → each implementation, import → the symbol it names. Not dependencies. |
| `lsp-definition`, `lsp-reference` | A language server answered (after `lsp-update`, or `analyze` with Docker). |

### `apiRouteLinks[].matchedVia`

How a call's URL was paired with a route:

| Value | Means |
|-------|-------|
| `exact` | Method and path match one route. |
| `service:<project>` | The call's origin named the project, and the route was matched among that project's routes. |
| `contract` | The call goes through a client proxy of a shared API interface; matched on the interface operation, no URL needed. |
| `base-prefix:<p>` | The two sides disagreed about a base such as `/api`; `<p>` is the prefix that reconciled them. Check that it is real. |
| `base-unresolved`, `route-prefix-unresolved` | One side's base was a runtime value; matched as a unique suffix. |
| `version-assumed` | A runtime segment of the URL was read as the API version. |
| `version-mismatch` | The client asks for an API version no route at that path declares. `AMBIGUOUS`: the best remaining guess. |
| `method-fallback` | Path matched, method unknown. |

### When a link is missing

`apiRouteLinkStats` accounts for every outbound call:

```json
"apiRouteLinkStats": {
  "calls": 11, "joinable": 10, "linked": 10, "unmatched": 0,
  "refused": { "methodMismatch": 0, "wildcardOnly": 0, "ambiguousSuffix": 0, "originMismatch": 0 },
  "crossProject": 10, "otherHost": 1, "unresolvedBase": 0,
  "byRole": { "production": 10, "test": 0, "generated": 0 }
}
```

| Counter | A call was not linked because |
|---------|-------------------------------|
| `refused.methodMismatch` | Routes exist at that path, but none serves the method. Usually a real bug on one side. |
| `refused.originMismatch` | The call's origin names a service, and that service has no matching route. Often a route renamed or removed on one side only. |
| `refused.ambiguousSuffix` | Only the tail of the path was known, and several routes end that way. |
| `refused.wildcardOnly` | The URL is all parameters (`/{}/{}`) — it names no route. |
| `unmatched` | No route anywhere matches. The endpoint may be outside the analyzed folder. |
| `otherHost` | The URL is absolute and names a host outside the analysis (`https://api.stripe.com/…`). Not a failure. |
| `unresolvedBase` | The base URL is a runtime value nothing resolved. These calls link only when their path is unique. |

The ClarifyDoc linker refuses rather than guesses: a refused call is reported, never linked to the nearest
look-alike.

## The other files

### `impact-latest.json` and `impact --json`

The same shape: changed files projected onto the analysis. `analyze --incremental` writes
`impact-latest.json` from its second run, against the previous run's manifest; `clarifydoc impact --json`
prints it for a git diff or a file list.

| Field | Holds |
|-------|-------|
| `baseLabel` | What the change set was diffed against: a git ref, `staged`, `--files`, `previous analysis run`. |
| `changedFiles`, `removedFiles` | Changed files the analysis knows; files deleted since the previous run. |
| `unknownFiles` | Changed paths the analysis has no entry for: new or non-source files (`package.json`). |
| `screens`, `routes`, `entities`, `queues` (+ `…Count`) | What the changed code reaches, in both directions: the screens and routes whose code runs through it, the entities and queues it touches. Lists are capped; the counts are exact, and `truncated: true` says a cap was hit. |
| `dependents`, `tests` (+ counts) | Files that import the changed ones, transitively; the test files among them and the changed set — the tests to run. |
| `chains` | Sample import chains from a changed file to a screen or route, so the reach is explainable. |
| `risk` | `level` (`low`, `moderate`, `high`) and the `reasons`. |

### `manifest.json`

Written by `--incremental`: per analyzed file its `sha256` and `mtime`, plus the `extractorVersion`. A file
whose hash matches is reused from its per-file JSON. A new ClarifyDoc version whose extraction changed has a
new `extractorVersion`, which discards every cached file at once — so the cache never mixes versions.

### `lsp-enhancement.json` and `lsp-ground-truth.json`

`lsp-enhancement.json` is the language-server layer: replacement `symbolLinks`, `componentGraph`,
`linkGraph` and `blastRadius` that include what the servers resolved, plus `lspStats` and `enhancedAt`. Its
paths are plain strings, not indices. `report` and `mcp` apply it on top of the summary when it is newer
than the summary; when it is older, they mark it `stale` in `lspStats` and ignore it. If you read the summary
yourself, apply the same rule — or use `loadReportSummary` (below), which does.

`lsp-ground-truth.json` logs every `definition` and `references` query with the raw answer, unresolved ones
included. It exists for measuring the text linker; you do not need it to read results.

### `report.html` and `report-data.json`

`report.html` is the full viewer in one file, with the analysis embedded (gzip + base64), so it works
offline and can be attached or hosted as is. `report-data.json` is that embedded data as plain JSON: a subset
of the summary shaped for the viewer, with its own index tables. Query `project-summary.json` instead — the
viewer payload changes with the viewer.

### `clarifydoc cfg --format json`

One entry per drawn function in `diagrams[]`, each with the `cfg` and its `mermaid` text. The graph has
`entry` and `exit` node ids, `nodes` (`id`, `kind` — `ENTRY`, `EXIT`, `STATEMENT`, `DECISION`, `LOOP`,
`MERGE`, `RETURN`, `THROW`, `BREAK_CONTINUE`, `CATCH` — the source `line`/`endLine`, and `inlineBranches`, the
branches inside a node that have none of their own) and `edges` (`from`, `to`, an optional `label` such as
`true`, `false`, `throws`). `unmodelled` and `unreachableBranches` list what the graph could not represent.

## Recipes

All of these run against `project-summary.json`. Sections are left out when empty, so the recipes read
them with `[]?` or `// []`.

```bash
# Every route with its file
jq -r '.files as $f | .routeMap[]
  | "\(.httpMethod // "ANY") \(.path)  →  \($f[.filePath]):\(.line)  (\(.projectId))"' project-summary.json

# Who calls an endpoint
jq -r '.files as $f | .apiRouteLinks[]? | select(.routePath == "/api/orders")
  | "\($f[.source]):\(.sourceLine)  \(.method) \(.url)"' project-summary.json

# Every frontend → backend link, with how it was matched
jq -r '.files as $f | .apiRouteLinks[]?
  | "\($f[.source]):\(.sourceLine) \(.method) \(.url) → \($f[.target]):\(.targetLine) [\(.confidence), \(.matchedVia)]"' \
  project-summary.json

# Endpoints that reach a database write
jq -r '.dataFlows[]? | select(.effect == "db-write") | "\(.entryLabel) → \(.resource)"' project-summary.json

# Which functions touch which tables
jq -r '.files as $f | .symbolDataAccess[]? | "\($f[.file]) \(.symbol) → \(.entity)"' project-summary.json

# Service → service dependencies
jq -r '.projectDependencies[]? | "\(.from) → \(.to)  \(.kind)  \(.endpoints | map(.name) | join(", "))"' \
  project-summary.json

# The five riskiest files to change
jq -r '.elements as $e | .blastRadius // [] | sort_by(-.impactScore)[:5][]
  | "\($e[.file].id | rtrimstr("::"))  \(.level)  impact=\(.impactScore)  \(.verdict.category // "")"' \
  project-summary.json

# The ten most complex functions
jq -r '.elements as $e | [.complexity[]?.functions[]] | sort_by(-.complexity)[:10][]
  | "\($e[.fn].id)  cyclomatic=\(.complexity) cognitive=\(.cognitive)"' project-summary.json

# Fail a CI job on a grade below B, a critical security finding, or a refused API call
jq -e '(.healthScore.grade | IN("A","B"))
  and ([.securityIssues[]? | select(.severity == "critical")] | length == 0)
  and ((.apiRouteLinkStats.refused // {} | add // 0) == 0)' project-summary.json > /dev/null
```

## Reading it from code

`denormalizeProject` from the `clarifydoc` package turns the summary back into its in-memory shape, with
every index replaced by the path or symbol it points at. `loadReportSummary` does that **and** applies a
current `lsp-enhancement.json` — it is what `report`, `impact` and `mcp` read through.

```typescript
import { loadReportSummary } from "clarifydoc";

const summary = await loadReportSummary(".clarifydoc/shop");

for (const link of summary.symbolLinks) {
  if (link.relation === "http") {
    console.log(`${link.sourceFile}:${link.sourceLine} ${link.callName} → ${link.targetFile} ${link.targetSymbol}`);
  }
}
```

In that shape a symbol link carries `sourceFile`, `sourceSymbol`, `sourceLine`, `targetFile`, `targetSymbol`
and `targetLine` instead of `from`/`to`, and every `filePath` is a string. The types are `ProjectAnalysis`
and `FileAnalysis`, exported from the package.

Summaries written by older versions load the same way: the decoder detects the encoding, and every field
added since is optional.
