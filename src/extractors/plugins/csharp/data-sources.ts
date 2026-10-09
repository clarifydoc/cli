import type { Node, Tree } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";
import { dbAccessFor, dbVerbTable } from "../shared/db-access.js";
import { csharpCallClient } from "./http-clients.js";

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
  "GetFromJsonAsync", "PostAsJsonAsync", "PutAsJsonAsync",
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
   * (`string GetAktivitetPath(Guid id) => $"{GetBasePath(id)}/aktiviteter";`,
   * `{ return $"{_basePath}/{_v3}/institution/{id}"; }`): name → the returned
   * expression. A client composes its URLs from them, so the call site names
   * the helper, never the path.
   */
  private pathHelpers = new Map<string, string>();

  override beginFile(_tree: Tree, sourceText: string): void {
    this.constStrings = new Map();
    // `const string`, and a `readonly`/`static` string field initialized with a
    // literal (`protected readonly string _basePath = "internal/api";`).
    for (const m of sourceText.matchAll(/\b(?:const|readonly|static)\s+string\s+(\w+)\s*=\s*[@$]*"([^"]*)"\s*;/g)) {
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
    if (evaluated) return evaluated;
    const direct = extractFirstStringArg(node);
    return direct ? this.substituteConsts(direct) : null;
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

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
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
      const looksLikeEf =
        DBCONTEXT_SUFFIX.test(root) ||
        root === "_context" || root === "context" || root === "db" ||
        root === "_db" || root === "dbContext" || root === "_dbContext";
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
        sources.push(this.ds({
          kind: "database",
          name: `EF: ${method}`,
          target: dbSet ?? receiver ?? null,
          ...(entity ? { entity } : {}),
          ...access(method, EF_ACCESS),
          line: node.startPosition.row + 1,
        }));
        return;
      }
    }

    // Dapper — IDbConnection.Query / Execute
    if (DAPPER_METHODS.has(method) &&
        (root === "connection" || root === "_connection" || root === "conn" ||
         /Connection$/.test(root))) {
      sources.push(this.ds({
        kind: "database",
        name: `Dapper: ${method}`,
        target: extractFirstStringArg(node),
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
      sources.push(this.ds({
        kind: "database",
        name: `ADO.NET: ${method}`,
        target: null,
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
      const entity = mqMessageEntity(argumentNodes(node));
      sources.push(this.ds({
        kind: "queue-publish",
        name: `MQ: ${method}`,
        target: null, // exchange is bound inside the wrapper, not at this call site
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
        sources.push(this.ds({
          kind: "api-call",
          name: method,
          target: this.resolveHttpUri(node),
          line: node.startPosition.row + 1,
          ...(client ? { baseRef: client } : {}),
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
  while (node) {
    if (node.type === "invocation_expression") {
      node = node.childForFieldName("function");
      continue;
    }
    if (node.type === "member_access_expression" || node.type === "member_expression") {
      const expr = node.childForFieldName("expression");
      const name = node.childForFieldName("name");
      if (!expr) return null;
      if (expr.type === "identifier" || expr.type === "identifier_name" || expr.type === "this_expression") {
        // Base of the chain: `<root>.<member>`. The member is the DbSet.
        return cleanEntityName(name?.text ?? null);
      }
      node = expr; // descend further left
      continue;
    }
    return null; // generic_name / element_access / unexpected — give up.
  }
  return null;
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
