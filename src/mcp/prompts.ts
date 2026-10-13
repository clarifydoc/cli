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
        `3. clarifydoc_extract symbol="${symbol}" file="${file}" — its source and the functions it calls.`,
        `4. clarifydoc_trace symbol="${symbol}" file="${file}" direction="callers" — who calls it, with file:line.`,
      ] : []),
      `${symbol ? 5 : 3}. clarifydoc_impact files=["${file}"] — the tests to run and the risk level.`,
      "Then summarize: what the change can break, which callers must be checked, and which tests to run.",
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
      "Then list every caller that must change with the endpoint, the data it touches, and what a client relying on today's contract would break on.",
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
];
