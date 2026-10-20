import type { McpTool } from "../protocol.js";
import type { ProjectAnalysis, RouteInfo } from "../../types/analysis.js";
import { numberArg, requiredStringArg, stringArg } from "../format.js";
import { requireAnalysis, type ToolContext } from "./context.js";
import { findRoutes, routeAnchor } from "../../core/sequence.js";
import { testsReaching } from "../../core/impact-diff.js";
import { routeFactId } from "../../core/fact-ids.js";

type Row = ProjectAnalysis["routeMap"][number];
type ToolText = (args: Record<string, unknown>) => Promise<string | null>;

/** About four characters a token — the same estimate the extract budgeter uses. */
const tokensOf = (s: string): number => Math.ceil(s.length / 4);

const VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i;

/**
 * Everything the analysis knows about one subject, packed into a token
 * budget in the order an agent needs it: for a route its contract and
 * callers, then what it reaches, then its handler's source, then its risk;
 * for a symbol its source, callers and risk; for a screen the screen, what
 * it calls and its source file. Each part is another tool's answer, so the
 * pack says nothing those tools would not — it saves the round trips. Parts
 * that do not fit are named at the end, with the call that gets them.
 */
export function explainTool(ctx: ToolContext, tools: McpTool[]): McpTool {
  const call = (name: string): ToolText => (args) => toolText(tools, name, args);
  const contract = call("clarifydoc_contract");
  const trace = call("clarifydoc_trace");
  const extract = call("clarifydoc_extract");
  const blast = call("clarifydoc_blast_radius");
  const screens = call("clarifydoc_screens");
  const file = call("clarifydoc_file");

  return {
    name: "clarifydoc_explain",
    title: "Explain a route, screen, symbol or file",
    description:
      "One call for the context of a route (\"POST /api/orders\"), a screen, a function (\"OrderService.create\") or a " +
      "file, packed into `maxTokens` in priority order: a route's contract and callers, the data it reaches, its " +
      "handler's source and its blast radius; a function's source, callers and risk. Use it before changing " +
      "something; follow the named calls for what did not fit.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: 'A route ("GET /api/users/{id}" or a path), a screen name, a function ("UserService.get") or a project-relative file.',
        },
        kind: { type: "string", enum: ["route", "screen", "symbol", "file", "community"], description: "What `subject` is, when the guess would be wrong." },
        file: { type: "string", description: "Narrow a symbol or route to this file (project-relative)." },
        maxTokens: { type: "number", description: "Budget for the whole answer (default 4000, max 20000)." },
      },
      required: ["subject"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary } = loaded;
      const subject = requiredStringArg(args, "subject").trim();
      const fileArg = stringArg(args, "file");
      const budget = numberArg(args, "maxTokens", 4000, { min: 500, max: 20000 });
      const kind = (stringArg(args, "kind") as Kind | undefined) ?? guessKind(subject, summary);

      const parts: Array<{ title: string; get: (left: number) => Promise<string | null>; follow: string }> = [];
      let heading = "";

      if (kind === "route") {
        const found = findRoutes(summary.routeMap ?? [], subject, fileArg);
        if (found.length === 0) return { text: `# No route matches "${subject}"\n\nNext: clarifydoc_routes path="${subject.replace(VERB, "")}" — list what is there` };
        if (found.length > 1) {
          return {
            text: [
              `# "${subject}" matches ${found.length} routes — pick one`,
              ...found.slice(0, 15).map((r) => `- ${label(r)} ${r.filePath}:${r.line} → clarifydoc_explain subject="${label(r)}" file="${r.filePath}"`),
            ].join("\n"),
          };
        }
        const r = found[0]!;
        const method = r.httpMethod ?? undefined;
        heading = `# ${label(r)} — ${r.handler ?? "inline handler"} (${r.filePath}:${r.line}) · [${routeFactId(r)}]`;
        const seed = r.handler ?? `route:${(r.httpMethod ?? "USE").toUpperCase()} ${r.path}`;
        if (r.kind === "api") parts.push({ title: "Contract and callers", get: () => contract({ path: r.path, ...(method ? { method } : {}), file: r.filePath }), follow: `clarifydoc_contract path="${r.path}"` });
        const anchor = routeAnchor(r, summary.symbolLinks ?? []);
        if (anchor) parts.push({ title: "What it reaches", get: () => trace({ symbol: anchor, file: r.filePath, direction: "callees", depth: 3, limit: 15 }), follow: `clarifydoc_trace symbol="${anchor}" file="${r.filePath}" direction="callees"` });
        if (r.handler) parts.push({ title: "Handler source", get: (left) => extract({ symbol: seed, file: r.filePath, depth: 0, maxTokens: Math.max(300, left) }), follow: `clarifydoc_extract symbol="${seed}" file="${r.filePath}"` });
        if (r.filePath) {
          const targets = [...(anchor ? [{ file: r.filePath, symbol: anchor }] : []), ...(r.handler ? [{ file: r.filePath, symbol: r.handler }] : [])];
          if (targets.length) parts.push({ title: "Tests", get: async () => testsPart(summary, targets), follow: `clarifydoc_trace symbol="${targets[0]!.symbol}" file="${r.filePath}" direction="callers"` });
        }
        parts.push({ title: "Risk", get: () => blast({ path: r.filePath }), follow: `clarifydoc_blast_radius path="${r.filePath}"` });
      } else if (kind === "screen") {
        heading = `# Screen ${subject}`;
        parts.push({ title: "Screen", get: () => screens({ query: subject }), follow: `clarifydoc_screens query="${subject}"` });
        const s = (summary.screens ?? []).find((x) => x.name === subject || x.filePath === subject);
        if (s) {
          parts.push({ title: "What it calls", get: () => trace({ file: s.filePath, direction: "callees", depth: 2, limit: 15 }), follow: `clarifydoc_trace file="${s.filePath}" direction="callees"` });
          parts.push({ title: "File", get: () => file({ path: s.filePath }), follow: `clarifydoc_file path="${s.filePath}"` });
        }
      } else if (kind === "community") {
        const id = communityOf(subject, summary);
        if (!id) return { text: `# No community is named "${subject}"\n\nNext: clarifydoc_architecture — lists the communities and their names` };
        const name = summary.communityNames?.[id]?.name ?? `community ${id}`;
        const members = [...(summary.communities?.[id] ?? [])].sort();
        heading = `# ${name} — ${members.length} file${members.length === 1 ? "" : "s"}${summary.communityNames?.[id]?.subsystem ? ` in ${summary.communityNames[id]!.subsystem}` : ""}`;
        parts.push({ title: "What it holds", get: async () => communityHolds(summary, new Set(members)), follow: `clarifydoc_architecture` });
        parts.push({ title: "What it depends on", get: async () => communityEdges(summary, id), follow: `clarifydoc_architecture` });
        parts.push({ title: "Files", get: async () => `${members.slice(0, 40).map((f) => `- ${f}`).join("\n")}${members.length > 40 ? `\n- … ${members.length - 40} more` : ""}`, follow: `clarifydoc_architecture` });
      } else if (kind === "file") {
        heading = `# ${subject}`;
        parts.push({ title: "File", get: () => file({ path: subject }), follow: `clarifydoc_file path="${subject}"` });
        parts.push({ title: "Risk", get: () => blast({ path: subject }), follow: `clarifydoc_blast_radius path="${subject}"` });
      } else {
        heading = `# ${subject}${fileArg ? ` (${fileArg})` : ""}`;
        const where = fileArg ? { file: fileArg } : {};
        parts.push({ title: "Source", get: (left) => extract({ symbol: subject, ...where, depth: 1, maxTokens: Math.max(300, Math.floor(left * 0.6)) }), follow: `clarifydoc_extract symbol="${subject}"` });
        parts.push({ title: "Callers", get: () => trace({ symbol: subject, ...where, direction: "callers", depth: 2, limit: 15 }), follow: `clarifydoc_trace symbol="${subject}" direction="callers"` });
        // The files declaring it, by the call graph: one, or the one named.
        const declaring = [...new Set((summary.symbolLinks ?? []).filter((l) => l.targetSymbol === subject && (!fileArg || l.targetFile === fileArg)).map((l) => l.targetFile))];
        if (declaring.length === 1) parts.push({ title: "Tests", get: async () => testsPart(summary, [{ file: declaring[0]!, symbol: subject }]), follow: `clarifydoc_trace symbol="${subject}" direction="callers"` });
        if (fileArg) parts.push({ title: "Risk", get: () => blast({ path: fileArg }), follow: `clarifydoc_blast_radius path="${fileArg}"` });
      }

      const out: string[] = [heading];
      const left = () => budget - tokensOf(out.join("\n\n"));
      const skipped: string[] = [];
      for (const p of parts) {
        const room = left();
        if (room < 120) {
          skipped.push(p.follow);
          continue;
        }
        const text = await p.get(room);
        if (!text) continue;
        const body = stripNext(text);
        // A part that found nothing ("No call-graph edges match …") is not context.
        if (/^No\b/.test(body)) continue;
        const section = `## ${p.title}\n\n${body}`;
        if (tokensOf(section) <= room) out.push(section);
        else {
          out.push(cut(section, room));
          skipped.push(`${p.follow} — the rest of "${p.title}"`);
        }
      }
      if (skipped.length) out.push(`Next (did not fit maxTokens=${budget}):\n${skipped.map((s) => `- ${s}`).join("\n")}`);
      return { text: out.join("\n\n") };
    },
  };
}

/** The tests that reach a subject through the call graph, and how to run them; saying so when none does. */
function testsPart(summary: ProjectAnalysis, targets: ReadonlyArray<{ file: string; symbol: string }>): string {
  const { tests, commands } = testsReaching(summary, targets);
  if (!tests.length) return "None of the analysed tests reaches it through the call graph.";
  return [
    ...tests.slice(0, 8).map((t) => `- ${t.symbol} (${t.file}:${t.line})${t.depth > 1 ? ` — ${t.depth} calls away` : ""}`),
    ...(tests.length > 8 ? [`- … ${tests.length - 8} more`] : []),
    ...commands.map((c) => `\nRun: \`${c.command}\``),
  ].join("\n");
}

/** Another tool's answer, or null when it failed or does not exist. */
async function toolText(tools: McpTool[], name: string, args: Record<string, unknown>): Promise<string | null> {
  const t = tools.find((x) => x.name === name);
  if (!t) return null;
  try {
    const r = await t.handler(args);
    return r.isError ? null : r.text;
  } catch {
    return null;
  }
}

function label(r: Row | RouteInfo): string {
  return `${r.httpMethod ? `${r.httpMethod.toUpperCase()} ` : ""}${r.path}`;
}

type Kind = "route" | "screen" | "symbol" | "file" | "community";

function guessKind(subject: string, summary: ProjectAnalysis): Kind {
  if (VERB.test(subject) || subject.startsWith("/")) return "route";
  if ((summary.files ?? []).includes(subject)) return "file";
  if ((summary.screens ?? []).some((s) => s.name === subject)) return "screen";
  // A community's name is a phrase ("Orders API"), never a function's.
  if (/\s/.test(subject) && communityOf(subject, summary)) return "community";
  return "symbol";
}

/** The community a subject names — by name, slug or id, case-insensitively — when exactly one does. */
function communityOf(subject: string, summary: ProjectAnalysis): string | null {
  const s = subject.trim().toLowerCase();
  const ids = Object.keys(summary.communities ?? {});
  const hits = ids.filter((id) => id.toLowerCase() === s || summary.communityNames?.[id]?.name.toLowerCase() === s || summary.communityNames?.[id]?.slug.toLowerCase() === s);
  return hits.length === 1 ? hits[0]! : null;
}

/** A community's routes, screens and entities: what its files declare. */
function communityHolds(summary: ProjectAnalysis, members: ReadonlySet<string>): string {
  const routes = (summary.routeMap ?? []).filter((r) => r.filePath && members.has(r.filePath));
  const screens = (summary.screens ?? []).filter((x) => members.has(x.filePath));
  const entities = (summary.entityGraph?.nodes ?? []).filter((n) => members.has(n.filePath));
  const lines: string[] = [];
  const list = <T>(title: string, items: T[], show: (t: T) => string) => {
    if (!items.length) return;
    lines.push(`${title} (${items.length}): ${items.slice(0, 12).map(show).join(", ")}${items.length > 12 ? ", …" : ""}`);
  };
  list("Routes", routes, (r) => `${r.httpMethod ? `${r.httpMethod.toUpperCase()} ` : ""}${r.path}`);
  list("Screens", screens, (x) => x.name);
  list("Entities", entities, (n) => n.name);
  return lines.length ? lines.join("\n") : "None of its files declares a route, a screen or an entity.";
}

/** The other communities this one imports from, and those importing from it, by file edges. */
function communityEdges(summary: ProjectAnalysis, id: string): string {
  const of = new Map<string, string>();
  for (const [cid, files] of Object.entries(summary.communities ?? {})) for (const f of files) of.set(f, cid);
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const [from, targets] of Object.entries(summary.componentGraph ?? {})) {
    for (const to of targets) {
      const a = of.get(from);
      const b = of.get(to);
      if (!a || !b || a === b) continue;
      if (a === id) outgoing.set(b, (outgoing.get(b) ?? 0) + 1);
      if (b === id) incoming.set(a, (incoming.get(a) ?? 0) + 1);
    }
  }
  const name = (cid: string) => summary.communityNames?.[cid]?.name ?? `community ${cid}`;
  const show = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([cid, n]) => `${name(cid)} (${n})`).join(", ");
  const lines = [
    outgoing.size ? `Imports from: ${show(outgoing)}` : "Imports from no other community.",
    incoming.size ? `Imported by: ${show(incoming)}` : "No other community imports from it.",
  ];
  return lines.join("\n");
}

/** A tool's own `Next:` line is about that tool alone; the pack ends with its own. */
function stripNext(text: string): string {
  return text.split("\n").filter((l) => !/^Next:/.test(l)).join("\n").trim();
}

/** A section cut at a line boundary to `tokens`. */
function cut(section: string, tokens: number): string {
  const max = tokens * 4;
  const head = section.slice(0, max);
  const at = head.lastIndexOf("\n");
  return `${head.slice(0, at > 0 ? at : max)}\n… (cut to fit)`;
}
