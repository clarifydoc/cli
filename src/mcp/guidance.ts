/**
 * When an agent should reach for ClarifyDoc instead of reading and grepping —
 * said once, and rendered twice: as the MCP server's instructions (shown to
 * the model at connection time) and as `AGENT_GUIDANCE`, a section a project
 * keeps in its AGENTS.md / CLAUDE.md so the agent knows before it connects.
 *
 * Each rule names the question, the tool, and why text search cannot answer
 * it — a model follows a reason better than a preference.
 */

interface ReachRule {
  question: string;
  tools: string;
  why: string;
}

const REACH_FOR: ReachRule[] = [
  {
    question: "What do I need to know before changing this route, screen or function?",
    tools: "clarifydoc_explain",
    why: "one call packs its contract, callers, the data it reaches, its source and its blast radius into a token budget, and names the calls for what did not fit",
  },
  {
    question: "Who calls this endpoint, and from which screen?",
    tools: "clarifydoc_routes",
    why: "it follows calls across the HTTP boundary — through client base URLs, proxies and gateways — where grep sees `\"/owners\"` and `[Route(\"[controller]\")]` as unrelated strings",
  },
  {
    question: "What breaks if I change this file, or this diff?",
    tools: "clarifydoc_blast_radius, clarifydoc_impact",
    why: "they name the dependents, the routes and screens whose execution passes through the change, and the tests to run",
  },
  {
    question: "What does this one function do?",
    tools: "clarifydoc_extract",
    why: "it returns the function's source and the functions it calls, cut to a token budget, instead of whole files",
  },
  {
    question: "Who calls this function, or how does A reach B?",
    tools: "clarifydoc_trace",
    why: "calls are resolved through dependency injection and interfaces; `to=` gives the call path between two symbols",
  },
  {
    question: "Which tables does this route or screen read and write?",
    tools: "clarifydoc_data_flows, clarifydoc_data_model",
    why: "each flow carries the call path from the entry point to the data",
  },
  {
    question: "How is this codebase organized, and what is coupled to what?",
    tools: "clarifydoc_architecture",
    why: "it gives folder dependencies with instability, communities, hub files, import cycles and files that change together in history — what reading files one by one cannot show",
  },
  {
    question: "What does this endpoint accept, and who may call it?",
    tools: "clarifydoc_contract",
    why: "it gives the request body's shape, the parameters' bindings and the auth policy as declared in code",
  },
];

const CAVEAT =
  "Facts are extracted from the source, not inferred, but cross-file links can be heuristic: rows tagged " +
  "`inferred` or `ambiguous` are lower-confidence and worth verifying in the source before acting on them.";

/** The MCP server's instructions. */
export const INSTRUCTIONS = `ClarifyDoc maps this codebase from its source — frontend route to API endpoint to database
table — with static analysis (tree-sitter/regex), not guesses. Use it to orient in unfamiliar code and to check
what a change touches, instead of grepping around.

Reach for it instead of reading files or searching text when the question is:
${REACH_FOR.map((r) => `- ${r.question} ${r.tools} — ${r.why}.`).join("\n")}

Suggested order:
1. clarifydoc_status — what has been mapped, and how stale it is.
2. clarifydoc_search — find a route, screen, symbol, table or file by name.
3. clarifydoc_file / clarifydoc_trace / clarifydoc_blast_radius — what a file contains, who calls it, what breaks
   if it changes.
4. clarifydoc_routes / clarifydoc_screens / clarifydoc_data_model / clarifydoc_data_flows — the cross-tier chain:
   which screen calls which endpoint, and which table that endpoint writes. Routes carry who may call them
   (policy, roles, scheme, or anonymous), which API versions they serve, and each parameter's binding; filter by
   those, and use clarifydoc_contract for one endpoint's full request shape before calling it.
   clarifydoc_services lifts the same links to sub-projects: which frontend, service or worker calls which.
5. clarifydoc_health and clarifydoc_impact — findings, and the effect of the current git diff (or, with proposed, of an edit before you make it).

${CAVEAT} Paths are project-relative, with \`path:line\` for anything you may want to open. If results look stale
after edits, call clarifydoc_analyze (incremental, cheap).`;

/**
 * A section for a project's AGENTS.md / CLAUDE.md: what the ClarifyDoc MCP
 * server answers, and when to use it rather than text search. Markdown,
 * starting with its own heading.
 */
export const AGENT_GUIDANCE = `## ClarifyDoc

This project has a ClarifyDoc analysis: a map from screens to API routes to database tables, extracted from the
source. The \`clarifydoc\` MCP server answers what text search cannot. Use it instead of reading files or grepping
when the question is:

${REACH_FOR.map((r) => `- **${r.question}** ${r.tools.split(", ").map((t) => `\`${t}\``).join(", ")} — ${r.why}.`).join("\n")}

${CAVEAT} If results look stale after edits, \`clarifydoc_analyze\` re-runs the analysis incrementally.
`;
