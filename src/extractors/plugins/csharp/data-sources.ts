import type { Node, Tree } from "web-tree-sitter";
import type { DataSourceInfo, Language, PathArgCall } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";
import { dbAccessFor, dbVerbTable } from "../shared/db-access.js";
import { tableFrom } from "../shared/sql-string-sources.js";
import { csharpCallClient } from "./http-clients.js";
import { csharpResponseReads } from "./response-reads.js";
import { csharpJsonBody } from "./request-body.js";

/**
 * C# data-source extractor — surfaces Entity Framework, Dapper, NHibernate,
 * raw ADO.NET, and HTTP client calls as DataSourceInfo entries.
 *
 * EF patterns recognised:
 *   - `_context.Users.Where(...)` / `db.Users.Find(id)` (DbSet<T> access)
 *   - `_context.SaveChanges()` / `SaveChangesAsync()`
 *   - `_context.Database.ExecuteSqlRaw(...)` / `FromSqlRaw(...)`
 *   - `dbSet.Add(entity)` / `dbSet.AddRange(entities)` / `Remove(entity)`
 *
 * Dapper: `connection.Query(...)` / `QueryAsync` / `Execute` / `ExecuteScalar`
 * NHibernate: `session.Query<T>()` / `session.Get<T>(id)` / `session.Save(entity)`
 * ADO.NET: `command.ExecuteReader()` / `ExecuteNonQuery()` / `ExecuteScalar()`
 */

const EF_READ_METHODS = new Set([
  "Find", "FindAsync",
  "First", "FirstOrDefault", "FirstAsync", "FirstOrDefaultAsync",
  "Single", "SingleOrDefault", "SingleAsync", "SingleOrDefaultAsync",
  "ToList", "ToListAsync", "ToArray", "ToArrayAsync",
  "Where", "Select", "Include", "ThenInclude", "OrderBy", "OrderByDescending",
  "GroupBy", "Join", "Count", "CountAsync", "Any", "AnyAsync",
  "FromSqlRaw", "FromSqlInterpolated", "FromSql",
]);

const EF_WRITE_METHODS = new Set([
  "Add", "AddAsync", "AddRange", "AddRangeAsync",
  "Update", "UpdateRange",
  "Remove", "RemoveRange",
  "Attach", "AttachRange",
  "SaveChanges", "SaveChangesAsync",
  "ExecuteSqlRaw", "ExecuteSqlInterpolated", "ExecuteSqlRawAsync", "ExecuteSqlInterpolatedAsync",
  "ExecuteUpdate", "ExecuteUpdateAsync", "ExecuteDelete", "ExecuteDeleteAsync",
]);

/** `{ access }` when the table classifies the leaf, `{}` when it does not. */
function access(leaf: string, table: Parameters<typeof dbAccessFor>[1]): { access?: "read" | "write" } {
  const a = dbAccessFor(leaf, table);
  return a ? { access: a } : {};
}

/**
 * Read/write classification, kept separate from the sets above because those
 * decide WHETHER a data source is emitted and this decides what it does.
 * Fluent composition (`Where`, `Select`, `Include`, `OrderBy`, `GroupBy`,
 * `Join`) is deliberately in neither: it builds a query, it does not execute
 * one, and calling it a read would attribute an access to the wrong line.
 * `Attach` counts as a write — on its own it only begins tracking, but it
 * exists to carry modified state into the next `SaveChanges`.
 */
const EF_ACCESS = dbVerbTable(
  [
    "Find", "FindAsync",
    "First", "FirstOrDefault", "FirstAsync", "FirstOrDefaultAsync",
    "Single", "SingleOrDefault", "SingleAsync", "SingleOrDefaultAsync",
    "ToList", "ToListAsync", "ToArray", "ToArrayAsync",
    "Count", "CountAsync", "Any", "AnyAsync",
    "FromSqlRaw", "FromSqlInterpolated", "FromSql",
  ],
  [
    "Add", "AddAsync", "AddRange", "AddRangeAsync",
    "Update", "UpdateRange", "Remove", "RemoveRange",
    "Attach", "AttachRange",
    "SaveChanges", "SaveChangesAsync",
    "ExecuteSqlRaw", "ExecuteSqlInterpolated", "ExecuteSqlRawAsync", "ExecuteSqlInterpolatedAsync",
    "ExecuteUpdate", "ExecuteUpdateAsync", "ExecuteDelete", "ExecuteDeleteAsync",
  ],
);

/** Dapper: `Execute` runs a non-query; every `Query*` and the scalar/reader pair read. */
const DAPPER_ACCESS = dbVerbTable(
  [
    "Query", "QueryAsync", "QueryFirst", "QueryFirstAsync",
    "QueryFirstOrDefault", "QueryFirstOrDefaultAsync",
    "QuerySingle", "QuerySingleAsync", "QuerySingleOrDefault",
    "QueryMultiple", "QueryMultipleAsync",
    "ExecuteScalar", "ExecuteScalarAsync", "ExecuteReader", "ExecuteReaderAsync",
  ],
  ["Execute", "ExecuteAsync"],
);

/** ADO.NET: `Open` is connection lifecycle, neither read nor write. */
const ADO_ACCESS = dbVerbTable(
  ["ExecuteReader", "ExecuteReaderAsync", "ExecuteScalar", "ExecuteScalarAsync", "Fill"],
  ["ExecuteNonQuery", "ExecuteNonQueryAsync"],
);

const NHIBERNATE_ACCESS = dbVerbTable(
  ["Query", "Get", "Load"],
  ["Save", "Update", "Delete", "SaveOrUpdate", "Merge"],
);

const DAPPER_METHODS = new Set([
  "Query", "QueryAsync", "QueryFirst", "QueryFirstAsync",
  "QueryFirstOrDefault", "QueryFirstOrDefaultAsync",
  "QuerySingle", "QuerySingleAsync", "QuerySingleOrDefault",
  "QueryMultiple", "QueryMultipleAsync",
  "Execute", "ExecuteAsync", "ExecuteScalar", "ExecuteScalarAsync",
  "ExecuteReader", "ExecuteReaderAsync",
]);

const ADO_METHODS = new Set([
  "ExecuteReader", "ExecuteReaderAsync",
  "ExecuteNonQuery", "ExecuteNonQueryAsync",
  "ExecuteScalar", "ExecuteScalarAsync",
  "Open", "OpenAsync", "Fill",
]);

const HTTP_CLIENT_METHODS = new Set([
  "GetAsync", "PostAsync", "PutAsync", "PatchAsync", "DeleteAsync",
  "SendAsync", "GetStringAsync", "GetByteArrayAsync", "GetStreamAsync",
  "GetFromJsonAsync", "PostAsJsonAsync", "PutAsJsonAsync", "PatchAsJsonAsync", "DeleteFromJsonAsync",
]);

// ─── Message queues (RabbitMQ.Client + publisher-wrapper heuristic) ─────────
// The raw client calls anchor the infrastructure layer; the wrapper heuristic
// anchors the *business* publish sites (`_eventPublisher.PublishAsync(...)`,
// `producer.ProduceAsync(msg, GrantExpiringMessage.RoutingKey)`) — which is
// where a button→API→handler→event trace actually terminates.

/** Raw RabbitMQ.Client publish calls (v6 sync + v7 async API). */
const MQ_RAW_PUBLISH = new Set(["BasicPublish", "BasicPublishAsync"]);
/** Raw RabbitMQ.Client consume calls. */
const MQ_RAW_CONSUME = new Set(["BasicConsume", "BasicConsumeAsync"]);

/**
 * Wrapper publish verbs. Only trusted on a broker-shaped receiver (below) so
 * `_mediator.Publish(notification)` (in-process MediatR) and MVC's
 * `producerService.Send(sms)` don't false-positive.
 */
const MQ_WRAPPER_PUBLISH_RE = /^(?:Publish|Produce)(?:Event|Message)?(?:Async)?$/;

/** Receiver that reads like a broker publisher (`_eventPublisher`, `producer`, `_bus`). */
const MQ_PUBLISHER_RECEIVER_RE = /publisher|producer|(?:^|_)bus$|broker/i;
/** A variable or message property that holds an AMQP routing key. */
const ROUTING_KEY_RE = /^_?routing_?key$/i;
/** In-process dispatchers that must never count as broker publishes. */
const MQ_RECEIVER_DENY_RE = /mediator|dispatcher/i;

/**
 * HttpClient verb methods whose names also read like repository/service
 * operations (`_repo.DeleteAsync(id)`). Only treated as outbound HTTP when the
 * receiver looks like an HttpClient — the other HTTP_CLIENT_METHODS entries are
 * HttpClient-specific enough to trust on name alone.
 */
const HTTP_AMBIGUOUS_METHODS = new Set([
  "GetAsync", "PostAsync", "PutAsync", "PatchAsync", "DeleteAsync", "SendAsync",
]);

/** Receiver names that identify an HttpClient (`_http`, `httpClient`, `_accountClient`, …). */
const HTTP_RECEIVER_RE = /http|client/i;

/** Detect EF DbContext "owner" patterns — names ending with Context/DbContext. */
const DBCONTEXT_SUFFIX = /Context$/;

// ─── Desktop/GUI I/O sinks (settings, clipboard, file storage) ──────────────
// A desktop/GUI app (e.g. a Blazor Hybrid / WinUI tool app) has no HTTP or DB
// tier — its "data" is the OS resources it reads/writes: user settings, the
// clipboard, and picked files. Surfacing these as `database` data sources (with
// a distinguishing `target` label) lets the existing screen→data-access→entity
// trace + Data Model show what each tool persists to — the desktop analogue of
// the screen→route→DB chain. The method names below are specific enough to a
// settings-provider / clipboard / file-storage abstraction that they don't
// collide with web/DB code (verified against the existing fixtures).

/** `ISettingsProvider.GetSetting(def)` / `SetSetting(def, v)` (and async variants). */
const SETTINGS_METHODS = new Set([
  "GetSetting", "SetSetting", "GetSettingAsync", "SetSettingAsync",
]);

/** `IClipboard.GetClipboardTextAsync()` / `SetClipboardImageAsync(...)` — every method is `(Get|Set)Clipboard*`. */
const CLIPBOARD_METHOD_RE = /^(?:Get|Set)Clipboard/;

/** `IFileStorage` methods distinctive enough to trust on name alone. */
const FILE_STORAGE_METHODS = new Set([
  "PickOpenFileAsync", "PickOpenFilesAsync", "PickSaveFileAsync", "PickFolderAsync",
  "CreateSelfDestroyingTempFile",
]);

/** `IFileStorage` methods that are generic enough to require a file-storage receiver. */
const FILE_STORAGE_RECEIVER_METHODS = new Set([
  "OpenReadFile", "OpenWriteFile", "FileExists", "ReadFileAsync", "WriteToFileAsync",
]);

/** A receiver that looks like an `IFileStorage` (`_fileStorage`, `fileStorage`). */
const FILE_STORAGE_RECEIVER_RE = /file.?storage/i;

export class CSharpDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["csharp"];

  /**
   * File-local `const string Name = "value"` bindings. Broker destinations are
   * habitually hoisted into consts (`private const string Exchange =
   * "shop-events"`); resolving them at the call site lets a publisher and a
   * consumer that share the destination meet at the same queue node.
   */
  private constStrings = new Map<string, string>();

  /**
   * String locals in declaration order (`var uri = $"api/v1/..."`), with their
   * lines. HttpClient URIs are habitually built into a local and passed by
   * name (`GetAsync(uri, ct)`) — without recalling the assignment, the
   * outbound call has no target and can never join a backend route. The same
   * local name recurs in every method (`var uri` per endpoint), so lookup is
   * by nearest PRECEDING assignment, not by name alone.
   */
  private stringLocals: Array<{ name: string; line: number; value: string }> = [];

  /**
   * Same-file methods that only return a path built from strings
   * (`string GetTrainingPath(Guid id) => $"{GetBasePath(id)}/trainings";`,
   * `{ return $"{_basePath}/{_v3}/institution/{id}"; }`): name → the returned
   * expression. A client composes its URLs from them, so the call site names
   * the helper, never the path.
   */
  private pathHelpers = new Map<string, string>();

  /**
   * Names declared as a `DbSet<T>` (field, property, parameter or local) →
   * the entity `T`, or null when `T` is a type parameter declared in the file
   * (`protected readonly DbSet<TClass> _dbSet;` in a generic base repository).
   * A repository habitually keeps its set in a field
   * (`private readonly DbSet<Note> _repository;`), and the name says nothing
   * about EF — the declared type does.
   */
  private dbSetNames = new Map<string, string | null>();
  /**
   * Locals holding a query on a set, by `<member node id>:<name>`
   * (`var q = _context.Set<Club>().AsQueryable();` → Club): a later
   * `q.Where(..).ToListAsync()` reads that set.
   */
  private efLocals = new Map<string, string>();

  override beginFile(tree: Tree, sourceText: string): void {
    this.dbSetNames = new Map();
    this.efLocals = new Map();
    if (sourceText.includes("DbSet<")) {
      const typeParams = new Set<string>();
      for (const tp of tree.rootNode.descendantsOfType("type_parameter")) {
        const name = tp.childForFieldName("name") ?? tp.namedChildren.find((c) => c.type === "identifier");
        if (name) typeParams.add(name.text);
      }
      for (const m of sourceText.matchAll(/\bI?DbSet<\s*([\w.]+)\s*>\??\s+(\w+)\b/g)) {
        const type = m[1]!.slice(m[1]!.lastIndexOf(".") + 1);
        if (!this.dbSetNames.has(m[2]!)) this.dbSetNames.set(m[2]!, typeParams.has(type) ? null : type);
      }
    }
    this.constStrings = new Map();
    // A method's own `const string url = "…";` is a local of that method (read
    // below as a string local by its line), never a value of the whole file.
    const localConsts = new Set<number>();
    if (/\bconst\s+string\b/.test(sourceText)) {
      for (const d of tree.rootNode.descendantsOfType("local_declaration_statement")) {
        if (d.text.startsWith("const")) localConsts.add(d.startPosition.row + 1);
      }
    }
    // `const string`, and a `readonly`/`static` string field initialized with a
    // literal (`protected readonly string _basePath = "internal/api";`).
    for (const m of sourceText.matchAll(/\b(?:const|readonly|static)\s+string\s+(\w+)\s*=\s*[@$]*"([^"]*)"\s*;/g)) {
      if (localConsts.size > 0 && localConsts.has(sourceText.slice(0, m.index!).split("\n").length)) continue;
      if (!this.constStrings.has(m[1]!)) this.constStrings.set(m[1]!, m[2]!);
    }
    this.pathHelpers = new Map();
    for (const m of sourceText.matchAll(/\bstring\s+(\w+)\s*\([^()]*\)\s*(?:=>\s*((?:[^;{}]|\{[^{}]*\})+);|\{\s*return\s+((?:[^;{}]|\{[^{}]*\})+);\s*\})/g)) {
      const expr = (m[2] ?? m[3] ?? "").trim();
      if (expr.includes('"') && !this.pathHelpers.has(m[1]!)) this.pathHelpers.set(m[1]!, expr);
    }
    this.stringLocals = [];
    // Each initializer as written (`$"api/v1/x"`, `GetPath(id) + "/x"`); `evalUri` reads it.
    for (const m of sourceText.matchAll(/\b(?:var|string)\s+(\w+)\s*=\s*([^;]+);/g)) {
      if (!m[2]!.includes('"') && !/^\s*\w+\s*\(/.test(m[2]!)) continue;
      const line = sourceText.slice(0, m.index!).split("\n").length;
      this.stringLocals.push({ name: m[1]!, line, value: m[2]!.trim() });
    }
  }

  /** Swap a captured label for its file-local const value, when one exists. */
  private mqResolve(label: string | null): string | null {
    if (!label) return null;
    return this.constStrings.get(label) ?? label;
  }

  /**
   * Substitute file-level const-string interpolations into a URI template:
   * `{_basePath}/license` (+ `_basePath = "internal/api/v1"`) →
   * `internal/api/v1/license`. Runtime parts stay as `{param}` placeholders,
   * which is exactly the form the route linker normalizes for matching.
   */
  private substituteConsts(uri: string): string {
    return uri.replace(/\{(\w+)\}/g, (whole, name: string) => this.constStrings.get(name) ?? whole);
  }

  /**
   * Resolve an HttpClient call's URI argument: a string/interpolated literal
   * directly, or an identifier via the nearest preceding string local.
   */
  private resolveHttpUri(node: Node): string | null {
    const callLine = node.startPosition.row + 1;
    const first = argumentNodes(node)[0]?.text.trim().replace(NAMED_ARG_RE, "").trim();
    const evaluated = first ? this.evalUri(first, callLine, 0) : null;
    const direct = evaluated ? null : extractFirstStringArg(node);
    const uri = evaluated ?? (direct ? this.substituteConsts(direct) : null);
    if (uri) return memberHoles(uri, node);
    // A helper handed its URL (`Task<T> Get<T>(string uri) => _httpClient.GetAsync(uri)`):
    // the parameter, as a hole each call site of the helper fills (`pathArgCalls`).
    if (first && /^[A-Za-z_]\w*$/.test(first) && this.nearestLocal(first, callLine) === null && enclosingParams(node).has(first)) {
      return `\${${first}}`;
    }
    return null;
  }

  /**
   * Calls handing a path to a method (`await Get<PersonViewModel>(uri, ct)`
   * with `var uri = $"{BasePath}/person/{id}"`): each argument as the URL it
   * evaluates to, null for one that states none. The core fills a helper's
   * `${uri}` with it (`expandRequestFactories`). Only calls with a path argument.
   */
  pathArgCallsOf(root: Node): PathArgCall[] {
    const out: PathArgCall[] = [];
    for (const inv of root.descendantsOfType("invocation_expression")) {
      const fn = inv.childForFieldName("function");
      const name = fn?.type === "identifier" || fn?.type === "generic_name" ? fn
        : fn?.type === "member_access_expression" && /^(?:this|base)$/.test(fn.firstChild?.type ?? "") ? fn.childForFieldName("name")
        : null;
      const callee = name?.text.replace(/<[\s\S]*$/, "");
      if (!callee) continue;
      const line = inv.startPosition.row + 1;
      const args = argumentNodes(inv).map((arg) => {
        const text = arg.text.trim().replace(NAMED_ARG_RE, "").trim();
        if (!/^[@$]*"|^[A-Za-z_]\w*$/.test(text)) return null;
        const v = this.evalUri(text, line, 0);
        return v && v.includes("/") ? memberHoles(v, inv) : null;
      });
      if (args.some((a) => a !== null)) out.push({ callee, args, line });
    }
    return out;
  }

  /** The nearest string local named `name` assigned at or before `line`. */
  private nearestLocal(name: string, line: number): string | null {
    let best: { line: number; value: string } | null = null;
    for (const l of this.stringLocals) {
      if (l.name === name && l.line <= line && (!best || l.line > best.line)) best = l;
    }
    return best?.value ?? null;
  }

  /**
   * A URI expression as a template: string literals (holes resolved through
   * consts and path helpers), `+` concatenation, a path helper's call, a const
   * or string local. A piece it cannot state becomes a `{hole}`; an expression
   * that is nothing but such a piece states no URI (null).
   */
  private evalUri(expr: string, line: number, depth: number): string | null {
    if (depth > 4) return null;
    const pieces = splitConcat(expr);
    if (!pieces) return null;
    let out = "";
    let stated = false;
    for (const raw of pieces) {
      const p = raw.trim();
      const lit = /^[@$]*"((?:[^"\\]|\\.)*)"$/.exec(p);
      const helper = /^(\w+)\s*\([^()]*\)$/.exec(p);
      if (lit) {
        out += this.fillHoles(lit[1]!, line, depth);
        stated = true;
      } else if (helper && this.pathHelpers.has(helper[1]!)) {
        const v = this.evalUri(this.pathHelpers.get(helper[1]!)!, line, depth + 1);
        if (v === null) return null;
        out += v;
        stated = true;
      } else if (/^\w+$/.test(p) && this.constStrings.has(p)) {
        out += this.fillHoles(this.constStrings.get(p)!, line, depth + 1);
        stated = true;
      } else if (/^\w+$/.test(p) && this.nearestLocal(p, line) !== null) {
        // A local whose initializer states no URI is a runtime part (`{name}`).
        const v = this.evalUri(this.nearestLocal(p, line)!, line, depth + 1);
        if (v !== null) stated = true;
        out += v ?? `{${p}}`;
      } else {
        out += `{${p}}`;
      }
    }
    return stated ? out : null;
  }

  /** Resolve the `{…}` holes of an interpolated template that name a const or a path helper. */
  private fillHoles(template: string, line: number, depth: number): string {
    return template.replace(/\{([^{}]+)\}/g, (whole, hole: string) => {
      const name = hole.split(":")[0]!.trim();
      if (this.constStrings.has(name)) return this.fillHoles(this.constStrings.get(name)!, line, depth + 1);
      const helper = /^(\w+)\s*\([^()]*\)$/.exec(name);
      if (helper && this.pathHelpers.has(helper[1]!) && depth < 4) {
        return this.evalUri(this.pathHelpers.get(helper[1]!)!, line, depth + 1) ?? whole;
      }
      return whole;
    });
  }

  /**
   * A consumer dispatching on the routing key of a delivered message
   * (`switch (message.RoutingKey) { case PlanRouting.TrainingCreated: … }`):
   * each constant case is a destination it consumes, named as the publisher
   * names it (`routingKeyAssignment`), so the two meet at one queue node.
   */
  private routingKeyCases(node: Node, sources: DataSourceInfo[]): void {
    const value = node.childForFieldName("value") ?? node.namedChildren[0];
    const subject = value?.type === "member_access_expression" ? value.childForFieldName("name")?.text : value?.text;
    if (!subject || !ROUTING_KEY_RE.test(subject)) return;
    const body = node.type === "switch_statement" ? node.childForFieldName("body") : node;
    for (const branch of body?.namedChildren ?? []) {
      if (branch.type !== "switch_section" && branch.type !== "switch_expression_arm") continue;
      for (const pattern of branch.namedChildren) {
        if (pattern.type !== "constant_pattern") continue;
        const label = this.routingKeyLabel(pattern.namedChildren[0] ?? null);
        if (!label) continue;
        sources.push(this.ds({
          kind: "queue-consume",
          name: "MQ: case RoutingKey",
          target: label,
          entity: label,
          line: pattern.startPosition.row + 1,
        }));
      }
    }
  }

  /**
   * A consumer that filters on the routing key (`if (routingKey != MatchPlayedMessage.RoutingKey) return;`,
   * `ea.RoutingKey == "league.match.played"`): it consumes that key.
   */
  private routingKeyComparison(node: Node, sources: DataSourceInfo[]): void {
    const op = node.childForFieldName("operator")?.text ?? node.children.find((c) => !c.isNamed)?.text;
    if (op !== "==" && op !== "!=") return;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    // The subject is a variable (`routingKey`, `ea.RoutingKey`); `MatchPlayedMessage.RoutingKey` is a class's constant.
    const subjectOf = (n: Node | null): string | undefined => {
      if (n?.type === "identifier") return n.text;
      if (n?.type !== "member_access_expression" || /^[A-Z]/.test(n.childForFieldName("expression")?.text ?? "")) return undefined;
      return n.childForFieldName("name")?.text;
    };
    const keyed = (n: Node | null): boolean => ROUTING_KEY_RE.test(subjectOf(n) ?? "");
    const other = keyed(left) ? right : keyed(right) ? left : null;
    // `routingKey == otherKey` names no key; neither does a comparison of two subjects.
    if (!other || keyed(other)) return;
    const label = this.routingKeyLabel(other);
    if (!label) return;
    sources.push(this.ds({
      kind: "queue-consume",
      name: "MQ: routing key filter",
      target: label,
      entity: label,
      line: node.startPosition.row + 1,
    }));
  }

  /**
   * A routing key the code decides on (`routingKey = PlanRouting.TrainingCreated;`):
   * what it publishes, however it hands the message on — straight to the
   * channel or through an outbox table a relay drains.
   */
  private routingKeyAssignment(node: Node, sources: DataSourceInfo[]): void {
    const left = node.childForFieldName(node.type === "assignment_expression" ? "left" : "name");
    if (left?.type !== "identifier" || !ROUTING_KEY_RE.test(left.text)) return;
    const right = node.type === "assignment_expression"
      ? node.childForFieldName("right")
      : node.namedChildren.find((c) => c.id !== left.id) ?? null;
    const label = this.routingKeyLabel(right);
    if (!label) return;
    sources.push(this.ds({
      kind: "queue-publish",
      name: "MQ: routing key",
      target: label,
      entity: label,
      line: node.startPosition.row + 1,
    }));
  }

  /**
   * A routing key as a destination label: a string literal, a file const's
   * value, or a constant member written `Class.Member` (its value is usually
   * composed in another file, and both sides spell it the same way).
   */
  private routingKeyLabel(node: Node | null): string | null {
    if (!node) return null;
    if (node.type === "string_literal" || node.type === "verbatim_string_literal") {
      const m = /^@?"([^"{}]+)"$/.exec(node.text);
      return m ? m[1]! : null;
    }
    if (node.type === "identifier") return this.constStrings.get(node.text) ?? null;
    if (node.type === "member_access_expression" && /^(?:[\w.]+\.)?[A-Z]\w*\.[A-Z]\w*$/.test(node.text.replace(/^global::/, ""))) {
      return node.text.split(".").slice(-2).join(".");
    }
    return null;
  }

  /** The EF access an invocation is, when it is one (see `visitNode`). */
  private efRow(node: Node): DataSourceInfo | null {
    const fn = node.childForFieldName("function");
    const fullName = fn ? this.fullCallName(fn) : null;
    if (!fn || !fullName) return null;
    const parts = fullName.split(".");
    const method = parts[parts.length - 1]!.replace(/<.*$/, "");
    if (!EF_READ_METHODS.has(method) && !EF_WRITE_METHODS.has(method)) return null;
    const receiver = parts.length > 1 ? parts[parts.length - 2]! : "";
    const root = parts[0]!;
    const base = chainBase(fn);
    const local = base !== null ? this.efLocals.get(`${enclosingMember(node)?.id}:${base}`) : undefined;
    if (base !== null && (this.dbSetNames.has(base) || local)) {
      const entity = local ?? this.dbSetNames.get(base) ?? undefined;
      return this.ds({
        kind: "database",
        name: `EF: ${method}`,
        target: entity ?? base,
        ...(entity ? { entity } : {}),
        ...access(method, EF_ACCESS),
        line: node.startPosition.row + 1,
      });
    }
    const contextNamed = (seg: string) =>
      DBCONTEXT_SUFFIX.test(seg) ||
      seg === "_context" || seg === "context" || seg === "Context" || seg === "db" ||
      seg === "_db" || seg === "dbContext" || seg === "_dbContext" || seg === "DbContext";
    // The context may sit behind a member: `services.Context.CatalogItems…` (eShop's
    // `[AsParameters] CatalogServices`), `this.uow.Db.Orders…`.
    // A `context` declared as one of the framework's own contexts (an MVC
    // `ValueProviderFactoryContext`, an `HttpContext`) holds no entity sets.
    if (FRAMEWORK_CONTEXT_TYPE.test(parameterType(node, root) ?? "")) return null;
    const looksLikeEf = contextNamed(root) || parts.slice(1, -2).some((seg) => contextNamed(seg.replace(/\(.*$/, "")));
    if (looksLikeEf || method === "SaveChanges" || method === "SaveChangesAsync" ||
        method === "FromSqlRaw" || method === "FromSqlInterpolated" || method === "FromSql" ||
        method === "ExecuteSqlRaw" || method === "ExecuteSqlInterpolated") {
      // Walk the receiver chain back to the `<context>.<DbSet>` access so the
      // entity resolves even when the EF method sits at the END of a fluent
      // chain — `_db.Owners.Include(..).OrderBy(..).ToListAsync()` would
      // otherwise take `OrderBy(..)`'s text as the receiver ("Name)") and
      // never identify the Owners DbSet. The DbSet name is the touched
      // entity; `attributeDataAccessToSymbols` matches it (case-insensitive,
      // singular/plural) to the ER node, bridging the trace to the data model.
      const dbSet = resolveEfDbSet(fn);
      const entity = dbSet && !NON_ENTITY_EF_METHODS.has(method) ? dbSet : undefined;
      return this.ds({
        kind: "database",
        name: `EF: ${method}`,
        target: dbSet ?? receiver ?? null,
        ...(entity ? { entity } : {}),
        ...access(method, EF_ACCESS),
        line: node.startPosition.row + 1,
      });
    }
    return null;
  }

  /** `var q = <a query on a set>;`: remember which set the local holds. */
  private recordEfLocal(declarator: Node): void {
    const name = declarator.childForFieldName("name")?.text ?? declarator.namedChildren.find((c) => c.type === "identifier")?.text;
    const value = declarator.namedChildren[declarator.namedChildren.length - 1];
    if (!name || !value || value.type === "identifier") return;
    const entity = this.efSetOf(value, declarator);
    if (entity) this.efLocals.set(`${enclosingMember(declarator)?.id}:${name}`, entity);
  }

  /**
   * The set an expression queries: `_context.Clubs`, `_context.Set<Club>()`,
   * either followed by query operators, a DbSet field, or a local holding one.
   * Null for anything else.
   */
  private efSetOf(expr: Node, at: Node): string | null {
    const fn = expr.type === "invocation_expression" ? expr.childForFieldName("function") : expr;
    if (!fn) return null;
    const base = chainBase(fn);
    if (base !== null && this.dbSetNames.has(base)) return this.dbSetNames.get(base) ?? null;
    const local = base !== null ? this.efLocals.get(`${enclosingMember(at)?.id}:${base}`) : undefined;
    if (local) return local;
    const root = (this.fullCallName(fn) ?? "").split(".")[0]!;
    if (!/^(?:_?(?:db)?[Cc]ontext|\w+Context|_?db|_?dbContext)$/.test(root)) return null;
    // `_context.Set<Club>()` itself names its set; a query operator on one walks back to it.
    const own = fn.childForFieldName("name");
    if (expr.type === "invocation_expression" && own?.type === "generic_name" && /^Set</.test(own.text)) return cleanEntityName(own.text);
    if (expr.type === "invocation_expression") return resolveEfDbSet(fn);
    return cleanEntityName(fn.childForFieldName("name")?.text ?? null);
  }

  /** True when this invocation is the receiver of a later EF access in the same chain. */
  private efCallFollows(node: Node): boolean {
    let cur: Node = node;
    for (;;) {
      const member = cur.parent;
      if (member?.type !== "member_access_expression" || member.childForFieldName("expression")?.id !== cur.id) return false;
      const call = member.parent;
      if (call?.type !== "invocation_expression" || call.childForFieldName("function")?.id !== member.id) return false;
      if (this.efRow(call)) return true;
      cur = call;
    }
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "switch_statement" || node.type === "switch_expression") {
      this.routingKeyCases(node, sources);
      return;
    }
    if (node.type === "binary_expression") {
      this.routingKeyComparison(node, sources);
      return;
    }
    if (node.type === "assignment_expression" || node.type === "variable_declarator") {
      this.routingKeyAssignment(node, sources);
      if (node.type === "variable_declarator") this.recordEfLocal(node);
      return;
    }
    // LINQ query syntax: each `from x in <set>` / `join y in <set>` reads that set.
    if (node.type === "from_clause" || node.type === "join_clause") {
      const inAt = node.children.findIndex((c) => c.type === "in");
      const source = inAt >= 0 ? node.children.slice(inAt + 1).find((c) => c.isNamed) : undefined;
      const entity = source ? this.efSetOf(source, node) : null;
      if (entity) sources.push(this.ds({ kind: "database", name: `EF: ${node.type === "join_clause" ? "join" : "from"}`, target: entity, entity, access: "read", line: node.startPosition.row + 1 }));
      return;
    }
    if (node.type !== "invocation_expression") return;

    const fn = node.childForFieldName("function");
    if (!fn) return;
    const fullName = this.fullCallName(fn);
    if (!fullName) return;

    const parts = fullName.split(".");
    // Strip an explicit type argument off the method token so generic calls
    // (`GetFromJsonAsync<Owner>`, `Query<Account>`) match the method-name sets.
    const method = parts[parts.length - 1]!.replace(/<.*$/, "");
    const receiver = parts.length > 1 ? parts[parts.length - 2]! : "";
    const root = parts[0]!;

    // EF Core / EF 6 — DbContext.Set<T>(), context.Entities.Where(), SaveChanges()
    if (EF_READ_METHODS.has(method) || EF_WRITE_METHODS.has(method)) {
      const row = this.efRow(node);
      if (row) {
        // One row per query: `_db.Owners.Where(..).Include(..).ToListAsync()` is
        // one access, recorded on the outermost EF operator of the chain.
        if (!this.efCallFollows(node)) sources.push(row);
        return;
      }
    }

    // EF Core migration data fixes — `migrationBuilder.Sql(@"INSERT INTO ""Roles"" …")`:
    // one row per DML statement whose table resolves (DDL is the schema, not data).
    if (method === "Sql" && /^_?migrationBuilder$/i.test(root) && parts.length === 2) {
      const raw = argumentNodes(node)[0]?.namedChildren[0];
      const sql = raw?.type === "verbatim_string_literal" ? raw.text.slice(2, -1).replace(/""/g, '"')
        : raw?.type === "string_literal" ? raw.text.slice(1, -1).replace(/\\(.)/g, "$1")
        : null;
      for (const stmt of sql?.split(";") ?? []) {
        const hit = tableFrom(stmt);
        if (!hit || !/^(?:SELECT|INSERT|UPDATE|DELETE|MERGE)/.test(hit.verb)) continue;
        sources.push(this.ds({
          kind: "database",
          name: `EF migration: ${hit.verb.split(" ")[0]}`,
          target: hit.table,
          entity: hit.table,
          access: hit.verb === "SELECT" ? "read" : "write",
          line: node.startPosition.row + 1,
        }));
      }
      return;
    }

    // Dapper — IDbConnection.Query / Execute
    if (DAPPER_METHODS.has(method) &&
        (root === "connection" || root === "_connection" || root === "conn" ||
         /Connection$/.test(root))) {
      const sql = extractFirstStringArg(node);
      const hit = sql ? tableFrom(sql) : null;
      sources.push(this.ds({
        kind: "database",
        name: `Dapper: ${method}`,
        target: sql,
        ...(hit ? { entity: hit.table } : {}),
        ...access(method, DAPPER_ACCESS),
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // Raw ADO.NET — SqlCommand / SqlConnection
    if (ADO_METHODS.has(method) &&
        (root === "cmd" || root === "command" || /Command$/.test(root) ||
         root === "connection" || /Connection$/.test(root) ||
         root === "adapter" || /Adapter$/.test(root))) {
      const hit = adoCommandTable(node, receiver);
      sources.push(this.ds({
        kind: "database",
        name: `ADO.NET: ${method}`,
        target: hit?.table ?? null,
        ...(hit ? { entity: hit.table } : {}),
        ...access(method, ADO_ACCESS),
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // NHibernate — session.Query<T>(), session.Get<T>(id)
    if ((method === "Query" || method === "Get" || method === "Load" ||
         method === "Save" || method === "Update" || method === "Delete" ||
         method === "SaveOrUpdate" || method === "Merge") &&
        (root === "session" || root === "_session" || /Session$/.test(root))) {
      sources.push(this.ds({
        kind: "database",
        name: `NHibernate: ${method}`,
        target: receiver || null,
        ...access(method, NHIBERNATE_ACCESS),
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // RabbitMQ — raw client calls. `BasicPublish(Async)` / `BasicConsume(Async)`
    // exist only on RabbitMQ.Client channels, so the method name alone is
    // trusted. Exchange/queue names are frequently config-driven
    // (`_eventConsumerConfiguration.Queue`) — the argument's source text is
    // still captured as the destination label so publishers and consumers that
    // name the same config member meet at one queue node.
    if (MQ_RAW_PUBLISH.has(method)) {
      const args = argumentNodes(node);
      // Routing key: a literal is trusted as-is; a bare identifier only counts
      // when it resolves through a file-local const (a runtime variable does not
      // name the event).
      const rkLiteral = mqArgLabel(args, "routingKey", 1, /* literalOnly */ true);
      const rk = rkLiteral ?? this.constStrings.get(mqArgLabel(args, "routingKey", 1) ?? "") ?? null;
      sources.push(this.ds({
        kind: "queue-publish",
        name: `RabbitMQ: ${method}`,
        target: this.mqResolve(mqArgLabel(args, "exchange", 0)),
        ...(rk ? { entity: rk } : {}),
        line: node.startPosition.row + 1,
      }));
      return;
    }
    if (MQ_RAW_CONSUME.has(method)) {
      sources.push(this.ds({
        kind: "queue-consume",
        name: `RabbitMQ: ${method}`,
        target: this.mqResolve(mqArgLabel(argumentNodes(node), "queue", 0)),
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // Broker-publisher wrappers — `_eventPublisher.PublishAsync(...)`,
    // `producer.ProduceAsync(msg, GrantExpiringMessage.RoutingKey, ct)`. Real
    // codebases publish through an injected wrapper, not the raw channel; this
    // is the business-level publish site a screen→…→event trace terminates at.
    // Gated on a broker-shaped receiver so MediatR's in-process
    // `_mediator.Publish(...)` never counts.
    if (
      MQ_WRAPPER_PUBLISH_RE.test(method) &&
      (MQ_PUBLISHER_RECEIVER_RE.test(root) || MQ_PUBLISHER_RECEIVER_RE.test(receiver)) &&
      !MQ_RECEIVER_DENY_RE.test(root) && !MQ_RECEIVER_DENY_RE.test(receiver)
    ) {
      const args = argumentNodes(node);
      const entity = mqMessageEntity(args);
      // The routing key handed over (`MatchPlayedMessage.RoutingKey`) is the destination a
      // consumer filtering on the same key names; the exchange is bound inside the wrapper.
      const keyArg = args.map((a) => a.namedChildren[a.namedChildren.length - 1] ?? null)
        .find((e) => e?.type === "member_access_expression" && /^[A-Z]/.test(e.childForFieldName("expression")?.text ?? "") && ROUTING_KEY_RE.test(e.childForFieldName("name")?.text ?? ""));
      const key = keyArg ? this.routingKeyLabel(keyArg) : null;
      sources.push(this.ds({
        kind: "queue-publish",
        name: `MQ: ${method}`,
        target: key,
        ...(entity ? { entity } : {}),
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // Settings store — ISettingsProvider.GetSetting / SetSetting. Distinctive
    // names; treated as I/O on the synthetic "Settings" resource.
    if (SETTINGS_METHODS.has(method)) {
      sources.push(this.ds({
        kind: "database",
        name: `Settings: ${method}`,
        target: "settings",
        entity: "Settings",
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // Clipboard — IClipboard.(Get|Set)Clipboard*Async.
    if (CLIPBOARD_METHOD_RE.test(method)) {
      sources.push(this.ds({
        kind: "database",
        name: `Clipboard: ${method}`,
        target: "clipboard",
        entity: "Clipboard",
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // File storage — IFileStorage.PickOpenFileAsync / OpenWriteFile / … . The
    // generic verbs require a file-storage-shaped receiver; the Pick*/temp-file
    // methods are distinctive enough to trust on name alone.
    if (
      FILE_STORAGE_METHODS.has(method) ||
      (FILE_STORAGE_RECEIVER_METHODS.has(method) &&
        (FILE_STORAGE_RECEIVER_RE.test(root) || FILE_STORAGE_RECEIVER_RE.test(receiver)))
    ) {
      sources.push(this.ds({
        kind: "database",
        name: `FileStorage: ${method}`,
        target: "file-storage",
        entity: "FileStorage",
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // HttpClient — GetAsync, PostAsync, etc. The generic verbs (`GetAsync`,
    // `DeleteAsync`, `SendAsync`, …) collide with repository/service method
    // names (`_repo.DeleteAsync(id)`, `_service.GetAsync(id)`), so gate them on
    // an HttpClient-shaped receiver. The JSON/string/byte/stream variants
    // (`GetFromJsonAsync`, `PostAsJsonAsync`, …) are HttpClient-specific and
    // trusted without a receiver check.
    if (HTTP_CLIENT_METHODS.has(method)) {
      const httpish = HTTP_RECEIVER_RE.test(root) || HTTP_RECEIVER_RE.test(receiver);
      if (!HTTP_AMBIGUOUS_METHODS.has(method) || httpish) {
        // Which registered client the call goes through — its base address
        // says which service the relative URI is relative to.
        const client = csharpCallClient(node, root);
        const reads = /^(?:Get|Send)/.test(method) ? csharpResponseReads(node) : undefined;
        const body = /^(?:Post|Put|Patch)AsJsonAsync$/.test(method) ? csharpJsonBody(node) : null;
        sources.push(this.ds({
          kind: "api-call",
          name: method,
          target: this.resolveHttpUri(node),
          line: node.startPosition.row + 1,
          ...(client ? { baseRef: client } : {}),
          ...(reads ? { responseReads: reads } : {}),
          ...(body ? { requestBody: body } : {}),
        }));
      }
      return;
    }

    // Configuration / environment access — IConfiguration["KEY"] / Environment.GetEnvironmentVariable
    if (method === "GetEnvironmentVariable" && root === "Environment") {
      sources.push(this.ds({
        kind: "env",
        name: "GetEnvironmentVariable",
        target: extractFirstStringArg(node),
        line: node.startPosition.row + 1,
      }));
    }
  }

  /** Build a dot-qualified call name from `function` field of an invocation. */
  private fullCallName(node: Node): string | null {
    if (node.type === "identifier") return node.text;
    if (node.type === "member_access_expression" || node.type === "member_expression") {
      const expr = node.childForFieldName("expression");
      const name = node.childForFieldName("name");
      const left = expr ? this.fullCallName(expr) : null;
      const right = name?.text ?? "";
      if (!right) return left;
      return left ? `${left}.${right}` : right;
    }
    if (node.type === "generic_name") {
      return node.childForFieldName("name")?.text ?? node.text.split("<")[0]!;
    }
    return node.text;
  }
}

/**
 * EF methods that operate on the context/connection, not a specific entity set
 * (`SaveChanges`, raw SQL on `context.Database`) — no entity is attributed.
 */
const NON_ENTITY_EF_METHODS = new Set([
  "SaveChanges", "SaveChangesAsync",
  "FromSqlRaw", "FromSqlInterpolated", "FromSql",
  "ExecuteSqlRaw", "ExecuteSqlInterpolated", "ExecuteSqlRawAsync", "ExecuteSqlInterpolatedAsync",
]);

/** Context members that are not entity sets (raw-SQL / migration surfaces). */
const NON_DBSET_MEMBERS = new Set(["Database", "Model", "ChangeTracker", "Entry"]);

/**
 * Resolve the `DbSet` an EF call ultimately operates on by walking the receiver
 * chain of a member-access `function` node down to its `<root>.<DbSet>` base,
 * peeling intermediate fluent invocations (`.Where(..)`, `.Include(..)`, …).
 * Returns the (generic-unwrapped) DbSet/entity name, or null when the base isn't
 * a `<identifier>.<member>` access (e.g. `context.SaveChanges()`,
 * `context.Database.ExecuteSqlRaw(..)`, or a local `dbSet` variable we can't
 * attribute). `Set<T>()` is unwrapped to its type argument `T`.
 */
function resolveEfDbSet(fnNode: Node): string | null {
  let node: Node | null = fnNode.childForFieldName("expression") ?? null;
  // The member to the right of the one being looked at: the DbSet when the
  // base member is the context itself (`services.Context.CatalogItems`).
  let right: string | null = null;
  while (node) {
    if (node.type === "invocation_expression") {
      node = node.childForFieldName("function");
      right = null;
      continue;
    }
    if (node.type === "member_access_expression" || node.type === "member_expression") {
      const expr = node.childForFieldName("expression");
      const name = node.childForFieldName("name");
      if (!expr) return null;
      if (expr.type === "identifier" || expr.type === "identifier_name" || expr.type === "this_expression") {
        // Base of the chain: `<root>.<member>`. The member is the DbSet — unless
        // it is the context the root carries, and the DbSet is the next one.
        if (right && /^(?:_?(?:db)?[Cc]ontext|\w+Context|Db)$/.test(name?.text ?? "")) return cleanEntityName(right);
        return cleanEntityName(name?.text ?? null);
      }
      right = name?.text ?? null;
      node = expr; // descend further left
      continue;
    }
    return null; // generic_name / element_access / unexpected — give up.
  }
  return null;
}

/**
 * The name a member chain starts from: `_set` in `_set.Where(..).ToList`,
 * `this._set.Add`. Null when the chain starts anywhere else.
 */
function chainBase(fnNode: Node): string | null {
  let node: Node | null = fnNode;
  let member: string | null = null;
  while (node) {
    if (node.type === "invocation_expression") {
      node = node.childForFieldName("function");
      member = null;
      continue;
    }
    if (node.type === "member_access_expression") {
      member = node.childForFieldName("name")?.text ?? null;
      node = node.childForFieldName("expression") ?? node.firstChild;
      continue;
    }
    if (node.type === "identifier") return node.text;
    // `this.x` (an anonymous `this` token in current grammars).
    if (node.type === "this" || node.type === "this_expression") return member;
    return null;
  }
  return null;
}

/** Contexts ASP.NET and friends hand to a callback: never a `DbContext`. */
const FRAMEWORK_CONTEXT_TYPE = /(?:Http|Action|Filter|Factory|Binding|Executing|Executed|Exception|Result|View|Page|Controller|Validated|Validation|Token\w*|Message|Endpoint|Authorization|Hub|Execution|Logging|Rewrite|Redirect)Context$/;

/** The declared type of a parameter or local named `name` in the member around `node`, as written. */
function parameterType(node: Node, name: string): string | null {
  const member = enclosingMember(node);
  if (!member) return null;
  for (const p of member.descendantsOfType(["parameter", "variable_declaration"])) {
    if (!p) continue;
    if (p.type === "parameter" && p.childForFieldName("name")?.text === name) return p.childForFieldName("type")?.text ?? null;
    if (p.type === "variable_declaration" && p.namedChildren.some((d) => d?.type === "variable_declarator" && (d.childForFieldName("name") ?? d.namedChildren[0])?.text === name)) {
      return p.childForFieldName("type")?.text ?? null;
    }
  }
  return null;
}

/** The method, constructor or accessor a node sits in. */
function enclosingMember(node: Node): Node | null {
  let cur: Node | null = node.parent;
  while (cur && !MEMBER_SCOPES.has(cur.type)) cur = cur.parent;
  return cur;
}

/** Unwrap `Set<Order>` → "Order"; strip generics/namespace; drop non-DbSet members. */
function cleanEntityName(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const gen = s.match(/<\s*([A-Za-z_][\w.]*)\s*>/);
  if (gen) s = gen[1]!; // Set<Order>() → Order
  s = s.replace(/<.*$/, "").trim();
  const dot = s.lastIndexOf(".");
  if (dot >= 0) s = s.slice(dot + 1);
  if (!s || NON_DBSET_MEMBERS.has(s)) return null;
  return s;
}

/** Members whose bodies declare their own names (parameters, locals). */
const MEMBER_SCOPES: ReadonlySet<string> = new Set([
  "method_declaration", "constructor_declaration", "local_function_statement", "accessor_declaration",
  "property_declaration", "operator_declaration",
]);
/** Nodes that declare a name in a member body, and the field holding it. */
const NAME_DECLARATIONS: ReadonlyMap<string, string> = new Map([
  ["parameter", "name"], ["variable_declarator", "name"], ["foreach_statement", "left"],
  ["catch_declaration", "name"], ["declaration_expression", "name"],
]);

/**
 * A URI hole the call's own member does not declare (`{BasePath}` read in a
 * method with no such parameter or local) is a member of the class — written
 * `${this.BasePath}`, the form the project pass fills from the class chain's
 * field values (an inherited `const`, a base field set from what a subclass
 * passes to `base(…)`). Holes naming a parameter or local stay runtime values.
 */
function memberHoles(uri: string, call: Node): string {
  if (!/(?<!\$)\{(?:this\.)?[A-Za-z_]\w*\}/.test(uri)) return uri;
  let scope: Node | null = call.parent;
  while (scope && !MEMBER_SCOPES.has(scope.type)) scope = scope.parent;
  let inClass = scope?.parent ?? null;
  while (inClass && inClass.type !== "class_declaration" && inClass.type !== "record_declaration") inClass = inClass.parent;
  if (!scope || !inClass) return uri;
  const declared = new Set<string>();
  const stack: Node[] = [scope];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const field = NAME_DECLARATIONS.get(n.type);
    const named = field ? n.childForFieldName(field) : null;
    if (named?.type === "identifier") declared.add(named.text);
    if (n.type === "implicit_parameter" || (n.type === "identifier" && n.parent?.type === "lambda_expression")) declared.add(n.text);
    for (const c of n.namedChildren) stack.push(c);
  }
  return uri.replace(/(?<!\$)\{(?:this\.)?([A-Za-z_]\w*)\}/g, (whole, name: string) =>
    declared.has(name) ? whole : `\${this.${name}}`);
}

/** The parameter names of the method (or local function, lambda) a node sits in. */
function enclosingParams(node: Node): Set<string> {
  const out = new Set<string>();
  for (let p: Node | null = node.parent; p; p = p.parent) {
    if (!MEMBER_SCOPES.has(p.type) && p.type !== "lambda_expression") continue;
    const list = p.childForFieldName("parameters") ?? p.namedChildren.find((c) => c.type === "parameter_list");
    for (const param of list?.namedChildren ?? []) {
      const n = param.childForFieldName("name");
      if (n) out.add(n.text);
    }
    if (MEMBER_SCOPES.has(p.type)) break;
  }
  return out;
}

/** Every call handing a path to a method (`FileAnalysis.pathArgCalls`, the plugin's `pathArgCalls` hook). */
export function extractCsharpPathArgCalls(tree: Tree, sourceText: string): PathArgCall[] {
  const x = new CSharpDataSourceExtractor();
  x.beginFile(tree, sourceText);
  return x.pathArgCallsOf(tree.rootNode);
}

/** The `argument` children of an invocation's argument_list. */
function argumentNodes(node: Node): Node[] {
  const args = node.childForFieldName("arguments");
  if (!args) return [];
  return args.children.filter((c) => c.type === "argument");
}

const NAMED_ARG_RE = /^[A-Za-z_]\w*\s*:/;

/**
 * Label for an argument addressed by C# named-argument form (`exchange: expr`)
 * or position. String literals are unquoted; any other expression contributes
 * its source text (`_exchange`, `binding.Queue`) as a join label — unless
 * `literalOnly`, in which case non-literals return null. Positional fallback is
 * skipped when that slot is itself a named argument for something else.
 */
function mqArgLabel(args: Node[], name: string, index: number, literalOnly = false): string | null {
  const namedRe = new RegExp(`^${name}\\s*:`);
  let text: string | null = null;
  for (const a of args) {
    if (namedRe.test(a.text)) {
      text = a.text.replace(namedRe, "").trim();
      break;
    }
  }
  if (text === null) {
    const a = args[index];
    if (!a || NAMED_ARG_RE.test(a.text)) return null;
    text = a.text.trim();
  }
  const isLiteral = /^[@$]*"/.test(text);
  if (literalOnly && !isLiteral) return null;
  const cleaned = (isLiteral ? text.replace(/^[@$]*"|"$/g, "") : text).replace(/\s+/g, " ");
  return cleaned && cleaned.length <= 64 ? cleaned : null;
}

/**
 * Business-level event name for a wrapper publish, from its arguments:
 * `new OrderCreatedEvent(...)` → "OrderCreatedEvent";
 * `GrantExpiringMessage.RoutingKey` → "GrantExpiringMessage";
 * a plain `"license.expiring"` routing-key literal is used as-is.
 */
function mqMessageEntity(args: Node[]): string | null {
  for (const a of args) {
    const t = a.text.trim();
    const ctor = t.match(/^new\s+([A-Za-z_][\w.]*)/);
    if (ctor) return ctor[1]!.split(".").pop()!;
    const rk = t.match(/^([A-Za-z_][\w.]*)\.RoutingKey$/);
    if (rk) return rk[1]!.split(".").pop()!;
    if (/^[@$]*"[\w.\-:*#]+"$/.test(t)) return t.replace(/^[@$]*"|"$/g, "");
  }
  return null;
}

/**
 * Split a string expression on its top-level `+` (outside strings, brackets
 * and interpolation holes); null when a quote is left open.
 */
function splitConcat(expr: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"') {
      let j = i + 1;
      let holes = 0;
      for (; j < expr.length; j++) {
        if (expr[j] === "\\") j++;
        else if (expr[j] === "{") holes++;
        else if (expr[j] === "}") holes--;
        else if (expr[j] === '"' && holes <= 0) break;
      }
      if (j >= expr.length) return null;
      i = j;
    } else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "+" && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out;
}

/** Pull the first string-literal argument from an invocation_expression's arg list. */
/**
 * The table an ADO.NET command runs against, from the SQL the method gave it
 * before this call: the last `cmd.CommandText = "…"`, or the `new SqlCommand("…", conn)`
 * it was made with. Null when the text is built at runtime or names no table.
 */
function adoCommandTable(call: Node, command: string): { verb: string; table: string } | null {
  if (!/^\w+$/.test(command)) return null;
  let body: Node | null = call.parent;
  while (body && !/^(?:method|constructor|local_function|accessor)_declaration$|^lambda_expression$/.test(body.type)) body = body.parent;
  if (!body) return null;
  const before = body.text.slice(0, call.startIndex - body.startIndex);
  const literal = String.raw`(@?"(?:[^"\\]|\\.|"")*")`;
  const set = [...before.matchAll(new RegExp(String.raw`\b${command}\.CommandText\s*=\s*${literal}`, "g"))].pop()
    ?? [...before.matchAll(new RegExp(String.raw`\b${command}\s*=\s*new\s+\w*Command\s*\(\s*${literal}`, "g"))].pop();
  if (!set) return null;
  return tableFrom(set[1]!.replace(/^@?"|"$/g, "").replace(/""/g, '"'));
}

function extractFirstStringArg(node: Node): string | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;
  for (const arg of args.children) {
    // arg is typically `argument` wrapping a string_literal
    const inner = arg.childCount > 0 ? arg.child(0) : null;
    const target = inner ?? arg;
    if (target.type === "string_literal" || target.type === "interpolated_string_expression" ||
        target.type === "verbatim_string_literal") {
      return target.text.replace(/^[@$]*["']|["']$/g, "");
    }
  }
  return null;
}
