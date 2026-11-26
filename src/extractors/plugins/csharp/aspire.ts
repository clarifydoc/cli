import type { DeployedResourceFact, DeployedServiceKind } from "../../../types/analysis.js";
import { blankStringAwareComments, lineIndex, matchingBracket } from "../shared/text-scan.js";
import { splitTopLevel as splitTopLevelWith } from "../../shared/split-top-level.js";

/**
 * A .NET Aspire AppHost (`DistributedApplication.CreateBuilder(args)`) as an
 * address book: every resource it adds — `AddProject<Projects.League_Api>("api")`,
 * `AddNpmApp("web", "../web")`, `AddPostgres("pg").AddDatabase("leaguedb")`,
 * `AddRedis("cache")`, `AddRabbitMQ("bus")` — under the name service discovery
 * gives it (`https+http://api`), the project it runs, and the references
 * (`.WithReference(api)`) that hand one resource another's address.
 */

/** Resource builders: kind and family of what each adds. Apps run a project. */
const BUILDERS: Record<string, { kind: DeployedServiceKind; family?: string }> = {
  AddProject: { kind: "app" },
  AddCSharpApp: { kind: "app" },
  AddDotnetProject: { kind: "app" },
  AddNpmApp: { kind: "app" },
  AddNodeApp: { kind: "app" },
  AddViteApp: { kind: "app" },
  AddJavaScriptApp: { kind: "app" },
  AddPythonApp: { kind: "app" },
  AddUvicornApp: { kind: "app" },
  AddExecutable: { kind: "app" },
  AddContainer: { kind: "app" },
  AddDockerfile: { kind: "app" },
  AddPostgres: { kind: "datastore", family: "postgres" },
  AddSqlServer: { kind: "datastore", family: "sqlserver" },
  AddMySql: { kind: "datastore", family: "mysql" },
  AddMongoDB: { kind: "datastore", family: "mongodb" },
  AddOracle: { kind: "datastore", family: "oracle" },
  AddAzureCosmosDB: { kind: "datastore", family: "cosmosdb" },
  AddRedis: { kind: "cache", family: "redis" },
  AddGarnet: { kind: "cache", family: "garnet" },
  AddValkey: { kind: "cache", family: "valkey" },
  AddRabbitMQ: { kind: "queue", family: "rabbitmq" },
  AddKafka: { kind: "queue", family: "kafka" },
  AddNats: { kind: "queue", family: "nats" },
  AddAzureServiceBus: { kind: "queue", family: "servicebus" },
};
/** A database added on a server (`.AddDatabase("leaguedb")`): the server's kind and family. */
const CHILD_BUILDERS = new Set(["AddDatabase", "AddQueue", "AddTopic", "AddServiceBusQueue", "AddServiceBusTopic"]);

const EDGE_KIND: Record<DeployedServiceKind, "http" | "db" | "bus"> = {
  app: "http", datastore: "db", cache: "db", queue: "bus", proxy: "http", observability: "http", other: "http",
};

/** One `Add…(…)` or `With…(…)` link of a builder chain. */
interface Link { method: string; generic?: string; args: string[] }

/**
 * A .NET Aspire AppHost (`DistributedApplication.CreateBuilder(args)`) is an address book — every resource it adds
 * (`AddProject<Projects.League_Api>("api")`, `AddNpmApp`, `AddPostgres("pg").AddDatabase("leaguedb")`, `AddRedis`,
 * `AddRabbitMQ`) under the name service discovery gives it (`https+http://api`), the project it runs, and the
 * `.WithReference(…)` edges.
 */
export function extractAspireResources(sourceText: string): DeployedResourceFact[] {
  if (!/\bDistributedApplication\s*\.\s*CreateBuilder\s*\(/.test(sourceText)) return [];
  const text = blankComments(sourceText);
  const resources = new Map<string, DeployedResourceFact>();
  /** Variable → the resource name it holds. */
  const vars = new Map<string, string>();
  const edges: Array<{ from: string; to: string }> = [];
  let offset = 0;
  const lineAt = lineIndex(text);
  for (const stmt of text.split(";")) {
    const line = lineAt(offset + stmt.length - stmt.trimStart().length);
    offset += stmt.length + 1;
    const head = /^\s*(?:(?:var|IResourceBuilder<[^>]*(?:<[^>]*>)?[^>]*>)\s+(\w+)\s*=\s*)?(\w+)\s*\./.exec(stmt);
    if (!head) continue;
    const links = chainLinks(stmt.slice(head[0].length - 1));
    let current = vars.get(head[2]!) ?? null; // `api.WithReference(db)` continues `api`
    for (const link of links) {
      const builder = BUILDERS[link.method];
      const name = unquote(link.args[0]);
      if (builder && name) {
        const fact: DeployedResourceFact = { name, kind: builder.kind, line, ...(builder.family ? { family: builder.family } : {}) };
        const runs = link.method === "AddProject"
          ? (link.generic ? link.generic.replace(/^(?:global::)?Projects\./, "") : unquote(link.args[1]))
          : link.method === "AddContainer" ? undefined : unquote(link.args[1]);
        if (runs) fact.runs = runs;
        if (!resources.has(name)) resources.set(name, fact);
        current = name;
      } else if (CHILD_BUILDERS.has(link.method) && name && current) {
        const parent = resources.get(current);
        if (parent && !resources.has(name)) resources.set(name, { name, kind: parent.kind, line, ...(parent.family ? { family: parent.family } : {}) });
        current = name;
      } else if (link.method === "WithReference" && current) {
        const ref = /^(\w+)/.exec(link.args[0] ?? "")?.[1];
        const to = ref ? vars.get(ref) : undefined;
        if (to && to !== current) edges.push({ from: current, to });
      }
    }
    if (head[1] && current) vars.set(head[1], current);
  }
  for (const { from, to } of edges) {
    const source = resources.get(from);
    const target = resources.get(to);
    if (!source || !target) continue;
    const edge = { to, kind: EDGE_KIND[target.kind], via: `WithReference(${to})` };
    if (!(source.edges ??= []).some((e) => e.to === edge.to)) source.edges.push(edge);
  }
  return [...resources.values()];
}

/** The links of a chain starting at `.`: `.AddProject<Projects.X>("api").WithReference(db)`. */
function chainLinks(chain: string): Link[] {
  const out: Link[] = [];
  const re = /\.\s*(\w+)\s*(?:<\s*([\w.:]+)\s*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chain))) {
    const open = m.index + m[0].length - 1;
    const close = matchingBracket(chain, open, { pair: "()", quotes: '"' });
    if (close < 0) break;
    out.push({ method: m[1]!, ...(m[2] ? { generic: m[2] } : {}), args: splitArgs(chain.slice(open + 1, close)) });
    re.lastIndex = close + 1;
  }
  return out;
}

function splitArgs(s: string): string[] {
  return s.trim() ? splitTopLevelWith(s, { brackets: "()<>[]{}", quotes: "\"", escapes: "\"", trim: true, tail: "keep" }) : [];
}

/** A plain string literal's value (`name: "api"` too); undefined for anything else. */
function unquote(arg: string | undefined): string | undefined {
  const m = /^(?:\w+\s*:\s*)?@?"([^"\\{}]*)"$/.exec(arg?.trim() ?? "");
  return m?.[1] || undefined;
}

/** Comments blanked to spaces (lines kept), strings left as they are: double-quoted, closing on their line; a `/*` never closed is text. */
const blankComments = (s: string): string => blankStringAwareComments(s, { quotes: '"', stringsEndAtLine: true, unclosedBlockIsText: true });
