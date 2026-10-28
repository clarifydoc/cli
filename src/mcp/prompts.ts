import type { McpPrompt } from "./protocol.js";

/**
 * Workflows a client can offer by name: each fills in the order of tool calls
 * that answers one recurring question, so the model does not have to discover
 * it from the tool descriptions.
 */
export const WORKFLOW_PROMPTS: McpPrompt[] = [
  {
    name: "before-editing",
    title: "Before editing a file",
    description: "What to know before changing a file (and optionally one function in it): what it is, who depends on it, what breaks.",
    arguments: [
      { name: "file", description: "Project-relative path of the file to change.", required: true },
      { name: "symbol", description: "The function or method to change, if one." },
    ],
    render: ({ file, symbol }) => [
      `I am about to change \`${file}\`${symbol ? ` — specifically \`${symbol}\`` : ""}. Using the ClarifyDoc tools, in this order:`,
      `1. clarifydoc_file path="${file}" — what the file declares, its routes/screens/data access and its layer.`,
      `2. clarifydoc_blast_radius path="${file}" — what kind of file it is, who depends on it, and the screens and routes whose execution passes through it.`,
      ...(symbol ? [
        `3. clarifydoc_explain subject="${symbol}" file="${file}" — what it is (route handler, data access, …, from the facts), its source, callers and tests.`,
        `4. clarifydoc_trace symbol="${symbol}" file="${file}" direction="callers" — who calls it, with file:line.`,
      ] : []),
      `${symbol ? 5 : 3}. clarifydoc_context_docs file="${file}" — the decision records and WHY:/DECISION: comments about it, flagged when the code moved on after them.`,
      `${symbol ? 6 : 4}. clarifydoc_impact files=["${file}"] — the tests to run and the risk level.`,
      "Then summarize: what the change can break, which callers must be checked, which decisions it must respect, and which tests to run.",
    ].join("\n"),
  },
  {
    name: "trace-feature",
    title: "Trace a feature end to end",
    description: "Follow one feature from the screen through the API to the data it reads and writes.",
    arguments: [{ name: "feature", description: "A word for the feature: a screen, an endpoint, an entity (e.g. \"checkout\").", required: true }],
    render: ({ feature }) => [
      `Trace the "${feature}" feature end to end with the ClarifyDoc tools:`,
      `1. clarifydoc_search query="${feature}" — the screens, routes, symbols and entities it names.`,
      `2. clarifydoc_screens query="${feature}" and clarifydoc_routes path="${feature}" — the entry points, the API calls a screen makes and the frontend files that call a route.`,
      `3. clarifydoc_data_flows — which of those entry points reach which tables and queues, with the call path (via).`,
      `4. clarifydoc_trace symbol=<the handler> to=<the repository or service method> — the exact call path, hop by hop, where one is unclear.`,
      "Then describe the flow as: screen → API call → route handler → services → data, naming file:line at each step and flagging any hop marked inferred or ambiguous.",
    ].join("\n"),
  },
  {
    name: "endpoint-gaps",
    title: "Find broken or unused endpoints",
    description: "Frontend calls that reach no backend route, and routes nothing in the repository calls.",
    arguments: [{ name: "path", description: "Narrow to URLs/routes containing this (optional)." }],
    render: ({ path }) => [
      `Use clarifydoc_routes gaps=true${path ? ` path="${path}"` : ""} to list the calls that reach no route and the routes no call reaches.`,
      "For each call that reaches no route, check whether the backend renamed or removed the endpoint (clarifydoc_routes path=<a segment of the URL>) and say which.",
      "For uncalled routes, remember an endpoint may be called from outside the repository; only call one dead when nothing in the repository and no external client plausibly uses it.",
    ].join("\n"),
  },
  {
    name: "before-changing-endpoint",
    title: "Before changing an endpoint",
    description: "What depends on one API endpoint before you change it: its contract, the code that calls it, and the data behind it.",
    arguments: [
      { name: "path", description: "The route path, or a distinctive part of it (e.g. /orders/{id}).", required: true },
      { name: "method", description: "The HTTP method, if the path serves several." },
    ],
    render: ({ path, method }) => [
      `I am about to change the endpoint ${method ? `${method} ` : ""}${path}. Using the ClarifyDoc tools, in this order:`,
      `1. clarifydoc_contract path="${path}"${method ? ` method="${method}"` : ""} — what it accepts today, its parameters' bindings and who may call it.`,
      `2. clarifydoc_routes path="${path}"${method ? ` method="${method}"` : ""} detail=true — the frontend files and services that call it, with their project.`,
      `3. clarifydoc_data_flows entry="${path}" entryKind="route" — the tables and queues it reads and writes, with the call path.`,
      "4. clarifydoc_trace symbol=<its handler> direction=\"callees\" — what the handler calls, where the flows above do not say.",
      `5. clarifydoc_explain subject="${method ? `${method} ` : ""}${path}" — among the rest, the other routes that share its tables: a change to the data's shape reaches them too.`,
      "Then list every caller that must change with the endpoint, the data it touches, the routes sharing that data, and what a client relying on today's contract would break on.",
    ].join("\n"),
  },
  {
    name: "explain-screen",
    title: "Explain a screen's data",
    description: "What one screen shows and changes: the API calls it makes, the routes that serve them, and the tables behind them.",
    arguments: [{ name: "screen", description: "The screen's name, route or file.", required: true }],
    render: ({ screen }) => [
      `Explain the data behind the "${screen}" screen with the ClarifyDoc tools:`,
      `1. clarifydoc_screens query="${screen}" detail=true — the screen, its route and the API calls it makes.`,
      `2. clarifydoc_routes path=<each call's URL> — the route that serves each call, and its handler.`,
      `3. clarifydoc_data_flows entry="${screen}" entryKind="screen" — the tables each reaches, read or written.`,
      "Then describe, for each user action on the screen: the call it makes, the endpoint that serves it, and the data it reads or changes, naming file:line and flagging any link marked inferred or ambiguous.",
    ].join("\n"),
  },
  {
    name: "before-writing",
    title: "Before writing new code",
    description: "Whether what you are about to write already exists in the project, and the installed API of a package you will call.",
    arguments: [
      { name: "what", description: "What the new code does, in a few words (e.g. \"format a match date\").", required: true },
      { name: "package", description: "A third-party package it will call, if one." },
    ],
    render: ({ what, package: pkg }) => [
      `Before writing code that will "${what}", check with the ClarifyDoc tools whether the project already has it:`,
      `1. clarifydoc_search query="${what}" — functions, classes, routes and files by name.`,
      `2. clarifydoc_search query="${what}" body=true — functions whose bodies and doc comments say it, under another name.`,
      "3. clarifydoc_explain subject=<a candidate> — what it is, who calls it and what it reaches, to judge whether it fits.",
      ...(pkg ? [`4. clarifydoc_extract package="${pkg}" — the API of the version installed here, not the one remembered (symbol=<an export> for its declaration).`] : []),
      "Then reuse or extend what exists, saying where; write new code only when nothing fits, and say what you searched for. No hit narrows the search; it does not prove absence.",
    ].join("\n"),
  },
  {
    name: "review-branch",
    title: "Review my branch's impact",
    description: "What the changes on this branch reach — routes, screens, data and tests — and how risky they are.",
    arguments: [{ name: "base", description: "The branch or commit to compare with (default HEAD: the uncommitted changes)." }],
    render: ({ base }) => [
      `Review the impact of ${base ? `the changes since ${base}` : "the uncommitted changes"} with the ClarifyDoc tools:`,
      `1. clarifydoc_impact${base ? ` base="${base}"` : ""} — the changed files, the routes and screens they reach, the data below them, the tests to run and the risk level with its reasons.`,
      "2. clarifydoc_contract path=<each affected route> — whether a changed file alters what the endpoint accepts.",
      "3. clarifydoc_health — any finding in the changed files.",
      "Then summarize for a reviewer: what changed in behavior a user or client would notice, what to test, and the riskiest file and why.",
    ].join("\n"),
  },
  {
    name: "refactor",
    title: "Plan and verify a multi-file refactor",
    description: "A rename, move or split across files: map what depends on it and the rule violations today, plan every edit, then check the result against that baseline.",
    arguments: [
      { name: "goal", description: "What the refactor does (e.g. \"move the pricing rules into the garage module\").", required: true },
      { name: "file", description: "Project-relative path of the file (or folder) it starts from.", required: true },
      { name: "symbol", description: "The function, class or method it renames or moves, if one." },
    ],
    render: ({ goal, file, symbol }) => [
      `Refactor: ${goal}. It starts at \`${file}\`${symbol ? `, \`${symbol}\`` : ""}. Work in four phases with the ClarifyDoc tools, and write the plan down before the first edit.`,
      "Phase 1 — map, before any edit:",
      `1. clarifydoc_blast_radius path="${file}" — the files that import it (through re-exports too) and the routes and screens whose execution passes through it.`,
      symbol
        ? `2. clarifydoc_trace symbol="${symbol}" file="${file}" direction="callers" depth=3 — every caller with file:line, followed through interfaces and dependency injection.`
        : `2. clarifydoc_file path="${file}" — what it declares and exports; then clarifydoc_trace symbol=<each export that moves> file="${file}" direction="callers" for its callers.`,
      `3. clarifydoc_health category="layers" — the layer and team-rule violations today. This is the baseline: note the count and each row.`,
      `4. clarifydoc_architecture view="cycles" — the import cycles today.`,
      `5. clarifydoc_context_docs file="${file}" — the decisions the new shape must respect.`,
      "Phase 2 — plan: list every file to edit and what changes in it — the moved or renamed declarations, each importer and caller from phase 1 (barrel and index re-exports included), and the tests — and where each piece lands. A move that makes a lower layer import a higher one adds a violation; choose the destination so it does not.",
      "Phase 3 — edit in the planned order: the declaration first, then each importer and caller. References built from strings (dynamic imports, config keys, reflection, templates) are not in the call graph: search the text for the old name and path before calling a step done.",
      "Phase 4 — verify:",
      "1. clarifydoc_analyze — refresh the analysis so the checks below see the edit.",
      "2. clarifydoc_impact — the files the change touched, the routes and screens they reach, the tests to run and the risk with its reasons.",
      `3. clarifydoc_health category="layers" — compare with the phase-1 baseline: a violation that is new is the refactor's to fix.`,
      `4. clarifydoc_architecture view="cycles" — no cycle the baseline did not have.`,
      ...(symbol ? [`5. clarifydoc_trace symbol=<its new name> direction="callers" — every caller from phase 1 reaches the new declaration; one missing still points at the old.`] : []),
      "Run the tests clarifydoc_impact named. Then report: what moved where, the callers updated, the violations and cycles before → after, and the tests run with their result.",
    ].join("\n"),
  },
];
