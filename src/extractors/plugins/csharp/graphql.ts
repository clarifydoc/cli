import type { ClassInfo, FileAnalysis, FunctionInfo, RouteFact } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { graphqlFieldRoute, type RootType } from "../shared/graphql-code-first.js";

/**
 * HotChocolate (C#) code-first schemas, as root fields (`POST /graphql/<field>`,
 * see `shared/graphql-code-first.ts`):
 *
 *   builder.Services.AddGraphQLServer().AddQueryType<Query>().AddTypeExtension<BookQueries>();
 *   [ExtendObjectType(OperationTypeNames.Query)]
 *   public class BookQueries {
 *       public IQueryable<Book> GetBooks([Service] AppDb db) => db.Books;          // field books
 *       [Authorize] public Task<Book?> GetBookByIdAsync(int id, AppDb db) => …;    // field bookById (id)
 *   }
 *   [QueryType] public static class Hello { public static string Greet(string name) => … }  // field greet
 *
 * A root class is one registered as a root type (`AddQueryType<T>()`, facts
 * collected per file, so a class registered elsewhere still counts), one
 * whose attribute says so (`[QueryType]`, `[ExtendObjectType("Query")]`,
 * `OperationTypeNames.Mutation`, `typeof(Mutation)`), or one named
 * Query/Mutation/Subscription in a file using HotChocolate. Each public
 * method or property is a field named as HotChocolate names it — `Get` and
 * `Async` dropped, camelCased — unless `[GraphQLName("x")]` says otherwise.
 * Its arguments are its parameters minus what the server injects — a type
 * the project registers in its container, a DbContext, a repository, a
 * `CancellationToken`, the resolver context (the `[Service]` attribute itself
 * does not survive on a parameter); `[Authorize]` on the method or class is its guard.
 */

export const HOTCHOCOLATE_ROOT = "hotchocolate-root";
/** A type the container builds (`AddSingleton<OrderStore>()`), injected into resolvers rather than passed by clients. */
export const HOTCHOCOLATE_INJECTABLE = "hotchocolate-injectable";
const SERVICE_REGISTRATION = /\.Add(?:Singleton|Scoped|Transient|DbContext|DbContextFactory|PooledDbContextFactory|HttpClient)<\s*([\w.]+)(?:\s*,\s*([\w.]+))?\s*>/g;
const REGISTRATION = /\.Add(Query|Mutation|Subscription)Type<\s*([\w.]+)\s*>|\.AddTypeExtension<\s*([\w.]+)\s*>/g;
const NOT_FIELDS = new Set(["ToString", "Equals", "GetHashCode", "GetType", "Dispose", "DisposeAsync"]);
const INJECTED = /^(?:CancellationToken|IResolverContext|ClaimsPrincipal|HttpContext|ITopicEventSender|ITopicEventReceiver|ILogger(?:<.*>)?|IServiceProvider|IHttpContextAccessor|\w*(?:DbContext|Db|Context|Service|Repository|Repo|Factory|Client|Mediator|Sender))$/;

/** `AddQueryType<Query>()` / `AddTypeExtension<BookQueries>()` in this file: root registrations. */
export function collectHotChocolateFacts(sourceText: string, facts: RouteFact[] | undefined): void {
  if (!facts) return;
  // Only beside the GraphQL server's own setup: every other project registers services too.
  if (/AddGraphQLServer|HotChocolate/.test(sourceText) && /\.Add(?:Singleton|Scoped|Transient|DbContext|DbContextFactory|PooledDbContextFactory|HttpClient)</.test(sourceText)) {
    for (const m of sourceText.matchAll(SERVICE_REGISTRATION)) {
      const line = sourceText.slice(0, m.index).split("\n").length;
      facts.push({ kind: HOTCHOCOLATE_INJECTABLE, line, data: { types: [m[1]!, ...(m[2] ? [m[2]] : [])].map((t) => t.split(".").pop()!) } });
    }
  }
  if (!sourceText.includes("Type<")) return;
  for (const m of sourceText.matchAll(REGISTRATION)) {
    const line = sourceText.slice(0, m.index).split("\n").length;
    facts.push({ kind: HOTCHOCOLATE_ROOT, line, data: { root: m[1] ?? null, cls: (m[2] ?? m[3])!.split(".").pop()! } });
  }
}

/** `GetBookByIdAsync` → `bookById`: HotChocolate's default field name. */
function fieldName(member: string): string {
  const n = member.replace(/^Get(?=[A-Z])/, "").replace(/Async$/, "");
  return n[0]!.toLowerCase() + n.slice(1);
}

const graphqlName = (decorators: readonly string[] | undefined): string | null =>
  (decorators ?? []).map((d) => /^GraphQLName\(\s*"([^"]+)"\s*\)$/.exec(d.trim())?.[1]).find(Boolean) ?? null;

/** The root type a class's attributes declare it part of. */
function attributeRoot(cls: ClassInfo): RootType | null {
  for (const d of cls.decorators ?? []) {
    const plain = /^(Query|Mutation|Subscription)Type$/.exec(d.trim());
    if (plain) return plain[1] as RootType;
    const ext = /^ExtendObjectType\(\s*(?:OperationTypeNames\.|typeof\(|")?(Query|Mutation|Subscription)\b/.exec(d.trim());
    if (ext) return ext[1] as RootType;
  }
  return null;
}

function rootRows(cls: ClassInfo, a: FileAnalysis, services: ReadonlySet<string>): void {
  const injected = (type: string | null | undefined): boolean => {
    const t = (type ?? "").replace(/\?$/, "").trim();
    return INJECTED.test(t) || services.has(t.split(".").pop()!);
  };
  const classGuards = (cls.decorators ?? []).filter((d) => /^Authorize\b/.test(d.trim()));
  const methods = (cls.methods ?? []).filter((m: FunctionInfo) => m.isExported && m.name !== cls.name && !NOT_FIELDS.has(m.name) && !/^(?:get|set)_/.test(m.name));
  for (const m of methods) {
    const guards = [...classGuards, ...(m.decorators ?? []).filter((d) => /^Authorize\b/.test(d.trim()))];
    a.routes.push(graphqlFieldRoute(graphqlName(m.decorators) ?? fieldName(m.name), `${cls.name}.${m.name}`, m.line, {
      args: m.params.filter((p) => !p.isReceiver && !injected(p.type)).map((p) => ({ name: p.name, type: p.type ?? null })),
      calls: m.calls,
      guards: guards.map((g) => ({ text: g, policies: [g] })),
    }));
  }
  for (const p of cls.properties ?? []) {
    if (p.visibility !== "public") continue;
    a.routes.push(graphqlFieldRoute(graphqlName(p.decorators) ?? fieldName(p.name), `${cls.name}.${p.name}`, cls.line));
  }
}

export const hotChocolateResolver: RouteResolver = {
  id: "hotchocolate-root-types",
  languages: ["csharp"],
  priority: 50,
  resolve(analyses: FileAnalysis[]): void {
    const registered = new Map<string, RootType | null>();
    // What the container builds is injected into a resolver, never a field argument (`[Service] OrderStore store`).
    const services = new Set<string>();
    for (const a of analyses) {
      for (const b of a.diBindings ?? []) for (const t of [b.service, b.implementation]) services.add(t.split(".").pop()!.replace(/<.*$/, ""));
      for (const f of a.routeFacts ?? []) {
        if (f.kind === HOTCHOCOLATE_INJECTABLE) for (const t of (f.data as { types: string[] }).types) services.add(t);
        if (f.kind !== HOTCHOCOLATE_ROOT) continue;
        const d = f.data as { root: RootType | null; cls: string };
        if (!registered.has(d.cls) || d.root) registered.set(d.cls, d.root);
      }
    }
    for (const a of analyses) {
      const usesHotChocolate = a.imports.some((i) => /^HotChocolate\b/.test(i.source));
      if (!usesHotChocolate && registered.size === 0) continue;
      for (const cls of a.classes ?? []) {
        const conventional = usesHotChocolate && /^(?:Query|Mutation|Subscription)$/.test(cls.name) ? (cls.name as RootType) : null;
        const root = attributeRoot(cls) ?? registered.get(cls.name) ?? (registered.has(cls.name) && cls.name.match(/^(Query|Mutation|Subscription)$/) ? (cls.name as RootType) : null) ?? conventional;
        if (root) rootRows(cls, a, services);
      }
    }
  },
};
