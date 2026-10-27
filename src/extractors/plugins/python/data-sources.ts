import type { Node } from "web-tree-sitter";
import { dbAccessFor, dbVerbTable, sqlVerbAccess } from "../shared/db-access.js";
import type { DataSourceInfo, FileAnalysis, JsonSchemaNode, Language } from "../../../types/analysis.js";
import { DataSourceExtractor, type ProjectApiCall } from "../../data-sources/base.js";
import type { ProjectContext } from "../../../types/project.js";
import { routineCalled, tableFrom } from "../shared/sql-string-sources.js";
import { pythonResponseReads } from "./response-reads.js";
import { pythonWhereFields } from "./arg-origins.js";
import { escapeRegex } from "../shared/path-utils.js";

export class PythonDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["python"];

  /**
   * A request whose URL a Python helper builds (`api_client.get(api_routes.clubs_slug(slug))`,
   * the helper `def clubs_slug(slug): return f"{prefix}/clubs/{slug}"` in the module the
   * name is imported as): the helper's path, a literal argument spliced in, any other
   * a `{}` segment, and the helper module's own values (`prefix`) filled.
   */
  override resolveProject(calls: ProjectApiCall[], analyses: FileAnalysis[], ctx: ProjectContext): number {
    const byFile = new Map(analyses.map((a) => [a.filePath, a]));
    let n = 0;
    for (const call of calls) {
      if (call.kind !== "api-call" || !call.target?.startsWith("${") || !call.filePath.endsWith(".py")) continue;
      const m = /^\$\{([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\(([^()]*)\)\}(.*)$/.exec(call.target);
      if (!m) continue;
      const [, head, member, argsText, rest] = m;
      const file = member ? ctx.importIndex.localFor(call.filePath, head!) : call.filePath;
      const helperFile = file ? byFile.get(file) : undefined;
      const name = member ?? head!;
      const helper = helperFile?.functions.find((f) => f.name === name && f.urlTemplate);
      if (!helper?.urlTemplate) continue;
      const args = argsText!.split(",").map((a) => a.trim()).filter((a) => a && !a.includes("="));
      let out = helper.urlTemplate;
      helper.params.forEach((p, i) => {
        const token = `{${p.name}}`;
        if (!out.includes(token)) return;
        const lit = i < args.length ? /^[rbuf]*(["'])(.*)\1$/.exec(args[i]!) : null;
        out = out.split(token).join(lit && !/^[a-z]*f/i.test(args[i]!) ? lit[2]! : "{}");
      });
      out = out.replace(/\$\{([A-Za-z_]\w*)\}/g, (hole, v: string) => helperFile!.moduleValues?.[v] ?? hole);
      call.target = out + rest!;
      n++;
    }
    return n;
  }

  /** Names this file binds to a vector-store client: `qdrant = QdrantClient(…)`, `self.db = chromadb.Client()`. */
  private vectorClients = new Set<string>();
  /** The file names Celery (an import, an app, `shared_task`): its `@x.task` functions are tasks. */
  private celery = false;
  /** Locals holding a Celery signature: `consume_task = consume_file.s(…)` → consume_task → consume_file. */
  private signatures = new Map<string, string>();
  /** The file composes Celery work (`chord`, `group`, `chain`, a `link=`): its signatures run. */
  private canvas = false;
  private sourceText = "";
  /** The file uses boto3 (SQS/SNS clients) or redis-py (pub/sub). */
  private boto3 = false;
  private redis = false;
  /** The file names urllib: a bare `urlopen(…)` is `urllib.request.urlopen`. */
  private urllib = false;

  /** String constants of the module and its classes: `QUEUE = "matches"`, `Queues.TRANSFERS` for `class Queues: TRANSFERS = "transfers"`. */
  private constants = new Map<string, string>();

  override beginFile(tree: unknown, sourceText: string): void {
    this.constants = /^\s*[A-Za-z_]\w*\s*(?::[^=\n]+)?=\s*[rbu]*['"]/m.test(sourceText) ? stringConstants((tree as { rootNode: Node }).rootNode) : new Map();
    this.vectorClients = new Set();
    this.celery = /\bcelery\b|\bshared_task\b/i.test(sourceText);
    this.boto3 = /\b(?:boto3|aioboto3)\b/.test(sourceText);
    this.redis = /^\s*(?:import\s+(?:redis|aioredis)|from\s+(?:redis|aioredis)(?:\.\w+)*\s+import)\b/m.test(sourceText);
    this.urllib = /\burllib2?\b/.test(sourceText);
    this.signatures = new Map();
    this.sourceText = sourceText;
    this.canvas = this.celery || /\b(?:chord|group|chain)\s*\(|\blink(?:_error)?\s*=/.test(sourceText);
    if (sourceText.includes(".s(") || sourceText.includes(".si(") || sourceText.includes(".signature(")) {
      for (const m of sourceText.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\.(?:s|si|signature)\(/gm)) {
        // Two assignments of one name to different tasks: refuse to choose.
        const prev = this.signatures.get(m[1]!);
        this.signatures.set(m[1]!, prev === undefined || prev === m[2]! ? m[2]! : "");
      }
      for (const [k, v] of this.signatures) if (!v) this.signatures.delete(k);
    }
    if (!/QdrantClient|chromadb|Pinecone|MilvusClient|weaviate/.test(sourceText)) return;
    for (const m of sourceText.matchAll(/(?:^|\s)(?:self\.)?([A-Za-z_]\w*)\s*(?::\s*[\w.\[\]]+\s*)?=\s*(?:await\s+)?(?:[\w.]+\.)?(?:QdrantClient|AsyncQdrantClient|PersistentClient|HttpClient|Client|Pinecone|MilvusClient|WeaviateClient|connect_to_\w+)\s*\(/gm)) {
      // `chromadb.Client()` / `HttpClient()` only from chromadb itself.
      if (/^(?:Client|HttpClient|PersistentClient)$/.test(m[0]!.match(/(\w+)\s*\($/)![1]!) && !/\bchromadb\b/.test(m[0]!) && !/from\s+chromadb\b/.test(sourceText)) continue;
      this.vectorClients.add(m[1]!);
    }
  }

  /** An argument as written, or the string a constant it names holds (`Queues.TRANSFERS`). */
  private constantOr(text: string | null): string | null {
    return text === null ? null : this.constants.get(text) ?? text;
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    // `os.environ["DATABASE_URL"]`: an environment read written as a subscript.
    if (node.type === "subscript" && node.childForFieldName("value")?.text === "os.environ") {
      const key = node.childForFieldName("subscript");
      const name = key?.type === "string" ? key.text.replace(/^[rbfu]*['"]{1,3}|['"]{1,3}$/gi, "") : null;
      if (name && /^[A-Za-z_][\w.-]*$/.test(name)) {
        sources.push(this.ds({ kind: "env", name: "os.environ", target: name, line: node.startPosition.row + 1 }));
      }
      return;
    }
    // Celery: a `@app.task` / `@shared_task` function consumes the task queue
    // named after it (or the decorator's `name=`); `.delay`/`.apply_async`
    // and `send_task` publish to it.
    if (node.type === "decorated_definition" && this.celery) {
      const def = node.childForFieldName("definition");
      const task = node.children.find((d) => d.type === "decorator" && CELERY_TASK_RE.test(d.text));
      const name = def?.type === "function_definition" ? def.childForFieldName("name")?.text : undefined;
      if (task && def && name) {
        const call = task.namedChildren.find((c) => c.type === "call");
        const declared = call ? pyArg(call, "name", -1) : null;
        sources.push(this.ds({
          kind: "queue-consume",
          name: "Celery: task",
          target: declared ? declared.split(".").pop()! : name,
          line: def.startPosition.row + 1,
        }));
      }
      return;
    }
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      const fnName = fn?.text;

      if (fnName) {
        // pika (RabbitMQ): channel.basic_publish(exchange=, routing_key=, body=)
        // / channel.basic_consume(queue=, on_message_callback=). The method
        // names are AMQP-specific, so any receiver is trusted.
        const leaf = fnName.split(".").pop()!;
        if (leaf === "basic_publish") {
          const routingKey = this.constantOr(pyArg(node, "routing_key", 1));
          const exchange = this.constantOr(pyArg(node, "exchange", 0));
          sources.push(this.ds({
            kind: "queue-publish",
            name: "RabbitMQ: basic_publish",
            // The default exchange (`exchange=""`) delivers to the queue the routing key names.
            target: exchange ?? (exchangeIsDefault(node) ? routingKey : null),
            ...(routingKey ? { entity: routingKey } : {}),
            line: node.startPosition.row + 1,
          }));
          return;
        }
        if ((leaf === "delay" || leaf === "apply_async") && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.(?:delay|apply_async)$/.test(fnName)) {
          const held = fnName.split(".").slice(-2, -1)[0]!;
          // A signature kept in a local (`consume_task = consume_file.s(…)`) is the task it signs.
          const task = (fnName === `${held}.${leaf}` ? this.signatures.get(held) : undefined) ?? held;
          if (task !== "self" && task !== "cls") {
            sources.push(this.ds({ kind: "queue-publish", name: `Celery: ${leaf}`, target: task, line: node.startPosition.row + 1 }));
            return;
          }
        }
        // A signature handed to a canvas (`chord(header=[consume_file.s(doc)], body=…)`, `link=[delete.si(ids)]`)
        // runs its task. One kept in a local the file runs itself (`sig.delay()`) is published there instead.
        if ((leaf === "s" || leaf === "si" || leaf === "signature") && this.canvas && /^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*\.(?:s|si|signature)$/.test(fnName)) {
          const task = fnName.split(".").slice(-2, -1)[0]!;
          const local = node.parent?.type === "assignment" && node.parent.childForFieldName("left")?.type === "identifier" ? node.parent.childForFieldName("left")!.text : null;
          const runHere = local !== null && this.signatures.get(local) === task && new RegExp(`\\b${local}\\.(?:delay|apply_async)\\(`).test(this.sourceText);
          if (task !== "self" && task !== "cls" && !runHere) {
            sources.push(this.ds({ kind: "queue-publish", name: `Celery: ${leaf}`, target: task, line: node.startPosition.row + 1 }));
            return;
          }
        }
        if (leaf === "send_task" && fnName.includes(".")) {
          const task = pyArg(node, "name", 0);
          if (task && /^[\w.]+$/.test(task)) {
            sources.push(this.ds({ kind: "queue-publish", name: "Celery: send_task", target: task.split(".").pop()!, line: node.startPosition.row + 1 }));
            return;
          }
        }
        // boto3: `sqs.send_message(QueueUrl=…)`, `sqs.receive_message(QueueUrl=…)`, `sns.publish(TopicArn=…)`.
        if (this.boto3 && (leaf === "send_message" || leaf === "send_message_batch" || leaf === "receive_message" || (leaf === "publish" && /sns/i.test(fnName)))) {
          const raw = pyArg(node, leaf === "publish" ? "TopicArn" : "QueueUrl", -1);
          const target = raw ? queueName(raw) : null;
          if (target) {
            sources.push(this.ds({
              kind: leaf === "receive_message" ? "queue-consume" : "queue-publish",
              name: leaf === "publish" ? "SNS: publish" : leaf === "receive_message" ? "SQS: receive" : "SQS: send",
              target,
              line: node.startPosition.row + 1,
            }));
            return;
          }
        }
        // redis-py pub/sub: `r.publish("orders", msg)`, `p.subscribe("orders")`.
        if (this.redis && (leaf === "publish" || leaf === "subscribe" || leaf === "psubscribe") && fnName.includes(".")) {
          const channel = pyArg(node, "channel", 0);
          if (channel && /^[\w.:*-]+$/.test(channel)) {
            sources.push(this.ds({ kind: leaf === "publish" ? "queue-publish" : "queue-consume", name: `Redis: ${leaf}`, target: channel, line: node.startPosition.row + 1 }));
            return;
          }
        }
        if (leaf === "basic_consume") {
          sources.push(this.ds({
            kind: "queue-consume",
            name: "RabbitMQ: basic_consume",
            target: this.constantOr(pyArg(node, "queue", 0)),
            line: node.startPosition.row + 1,
          }));
          return;
        }
        // A vector store's collection operations: `qdrant.upsert(collection_name="chunks", …)`.
        const recv = fnName.split(".").slice(0, -1).filter((p) => p !== "self").pop() ?? "";
        if (this.vectorClients.has(recv)) {
          const access = PY_VECTOR_READS.test(leaf) ? "read" : PY_VECTOR_WRITES.test(leaf) ? "write" : null;
          if (access) {
            const collection = pyArg(node, "collection_name", 0) ?? pyArg(node, "name", 0);
            const named = collection && /^[\w.-]+$/.test(collection) ? collection : null;
            sources.push(this.ds({
              kind: "database",
              name: fnName,
              target: named,
              ...(named ? { entity: named } : {}),
              line: node.startPosition.row + 1,
              access,
            }));
          }
          return;
        }

        // requests.get(url), httpx.post(url), session.get("/api/x"), urlopen(Request(url))
        const http = httpCall(fn!, node) ?? (this.urllib ? urlopenCall(fn!, node) : null);
        if (http) {
          const body = jsonBody(node);
          const reads = pythonResponseReads(node);
          const based = http.target ? statedBase(http.target, node) : null;
          // A Locust user's `self.client` sends to the host the run is started against (`--host`,
          // `LOCUST_HOST`): an app path behind a base nobody states here.
          const locust = !based && /^self\.client\.\w+$/.test(fnName) && /\bfrom\s+locust\b|\bimport\s+locust\b/.test(this.sourceText) && http.target?.startsWith("/");
          sources.push(this.ds({
            kind: "api-call",
            name: http.name,
            target: based ? based.target : (http.target ? statedPath(http.target, node) ?? http.target : http.target),
            ...(based ? { baseRef: { kind: "literal" as const, key: based.origin } } : {}),
            ...(locust ? { baseExpr: "self.client" } : {}),
            line: node.startPosition.row + 1,
            ...(body ? { requestBody: body } : {}),
            ...(reads ? { responseReads: reads } : {}),
          }));
          // An HTTP call is not also a database read (`session.get(url)`).
          return;
        }

        // os.environ, os.getenv
        if (fnName.includes("os.getenv") || fnName.includes("os.environ")) {
          // The variable read: `os.getenv("DATABASE_URL")`, `os.environ.get("X", default)`.
          const key = pyArg(node, "key", 0);
          sources.push(this.ds({
            kind: "env",
            name: fnName,
            target: key && /^[A-Za-z_][\w.-]*$/.test(key) ? key : null,
            line: node.startPosition.row + 1,
          }));
        }

        // Raw SQL a migration or an ORM annotation states: Django `migrations.RunSQL("…")` (a statement
        // or a list of them), `RawSQL("SELECT … FROM x")` in an annotation, Alembic `op.execute("UPDATE …")`
        // (also through `sa.text`). One row per data statement whose table resolves; DDL is the schema.
        const rawSql = leaf === "RunSQL" || leaf === "RawSQL" ? `Django: ${leaf}` : fnName === "op.execute" && /\balembic\b/.test(this.sourceText) ? "Alembic: execute" : null;
        if (rawSql) {
          let arg = positional(node)[0] ?? (node.childForFieldName("arguments")?.namedChildren ?? []).find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === "sql")?.childForFieldName("value") ?? undefined;
          if (arg?.type === "call" && /(?:^|\.)text$/.test(arg.childForFieldName("function")?.text ?? "")) arg = positional(arg)[0];
          const statements = arg?.type === "list" || arg?.type === "tuple" ? arg.namedChildren : arg ? [arg] : [];
          for (const s of statements) {
            const sql = pyStringValue(s, node);
            for (const stmt of sql?.split(";") ?? []) {
              // A hole names no table (`f"UPDATE {table} SET …"`).
              const hit = tableFrom(stmt.replace(/\{[^}]*\}/g, "hole__"));
              if (!hit || hit.table.includes("hole__") || !/^(?:SELECT|INSERT|UPDATE|DELETE|MERGE)/.test(hit.verb)) continue;
              const access = sqlVerbAccess(hit.verb);
              sources.push(this.ds({ kind: "database", name: rawSql, target: hit.table, entity: hit.table, line: node.startPosition.row + 1, ...(access ? { access } : {}) }));
            }
          }
          return;
        }

        // Database patterns — matched on the exact method LEAF, not substring:
        // `RE_CPP_CLASSNAME.findall(...)` (the re module) contains ".find" but
        // is not a DB op, and it was minting phantom regex-constant "entities".
        const parts = fnName.split(".");
        const receiver = parts.length > 1 ? parts[parts.length - 2]! : "";
        // Session-mutating verbs are ordinary English words (`add`, `delete`,
        // `merge`), so unlike the leaves above they are only trusted on a
        // session/connection-shaped receiver. Without them a SQLAlchemy write
        // was invisible: `session.add(order)` produced no data source at all,
        // and the file reported `writesState: false`.
        const isSessionWrite =
          PY_SESSION_WRITE_LEAVES.has(leaf) && PY_DB_RECEIVER_RE.test(receiver);
        // Generic verbs (`execute`, `find`, `filter`, `query`) are also every
        // interpreter's, string's and ElementTree's: they need the chain to
        // show a datastore — a session/cursor/collection receiver, a Django
        // manager (`.objects`), a SQLAlchemy query (`.query(...)`).
        // A model's Django manager queried, whatever the verb or custom manager method
        // (`Site.objects.annotate(…)`, `ContentType.objects.get_for_model(…)`, `.bulk_update(…)`).
        const djangoManager = /\.objects\./.test(fnName) && managerModel(fnName) !== null;
        const isQuery =
          PY_DB_LEAVES.has(leaf) || djangoManager ||
          (PY_GENERIC_DB_LEAVES.has(leaf) && (datastoreChain(fnName) || relatedManager(fnName, leaf))) ||
          (PY_SESSION_STATEMENT_LEAVES.has(leaf) && !fnName.includes("(") && PY_DB_RECEIVER_RE.test(receiver));
        if (fnName.includes(".") && (isQuery || isSessionWrite)) {
          let access = isSessionWrite ? "write" : dbAccessFor(leaf, PY_DB_ACCESS) ?? (djangoManager ? (DJANGO_WRITE_LEAVES.has(leaf) ? "write" : "read") : undefined);
          // Raw SQL (`cursor.execute(sql)`, `session.execute(text(q))`): the
          // statement names the table and says whether it reads or writes —
          // read from a literal or a local assigned one.
          let table: string | null = null;
          // The table is a module value (`"INSERT INTO " + TABLE_NAME + " …"`): its name, for the project pass to read.
          let tableRef: string | null = null;
          if (SQL_TEXT_LEAVES.has(leaf) || leaf === "callproc") {
            let arg = positional(node)[0];
            if (arg?.type === "call" && /(?:^|\.)text$/.test(arg.childForFieldName("function")?.text ?? "")) arg = positional(arg)[0];
            const sql = arg ? pyStringValue(arg, node) : null;
            // A stored procedure: `cursor.callproc("usp_SignPlayer", [pid])`, `cursor.execute("EXEC usp_X %s", …)`.
            const routine = sql !== null ? routineCalled(sql, leaf === "callproc") : null;
            if (routine) {
              sources.push(this.ds({ kind: "database", name: fnName, target: routine, routine: true, line: node.startPosition.row + 1 }));
              return;
            }
            const refs: string[] = [];
            // An f-string's `{…}` is a run-time value: in a table's place (`FROM {model.__tablename__}`) it names none.
            const hit = sql ? tableFrom(sql.replace(/\$\{([^}]*)\}|\{[^}]*\}/g, (_m, ref: string | undefined) => (ref ? `hole${refs.push(ref) - 1}__` : "holef__"))) : null;
            if (hit) {
              const hole = /^hole(\d+)__$/.exec(hit.table);
              if (hole) tableRef = refs[Number(hole[1])] ?? null;
              else if (!/hole\d+__|holef__/.test(hit.table)) table = hit.table;
              access ??= sqlVerbAccess(hit.verb);
            }
          }
          // A model's manager or query attribute (`Order.objects.filter`, `User.query.filter_by`)
          // names the model before it, not after: the segment ahead of the leaf is the manager.
          table ??= managerModel(fnName);
          // A row saved or deleted through the variable holding it (`self.club1.save()`,
          // `match.delete()`): its model is what the variable was built from, else
          // unknown — never the variable's name.
          let instance = false;
          if (!table && INSTANCE_VERBS.has(leaf) && parts.length >= 2) {
            const held = parts.slice(0, -1).join(".");
            const name = parts[parts.length - 2]!;
            if (/^(?:self\.)?[a-z_]\w*$/.test(held) && name !== "self" && name !== "objects" && !PY_DATASTORE_SEGMENT_RE.test(name)) {
              table = heldModel(held, this.sourceText);
              instance = !table;
            }
          }
          // A manager on a model held in a variable (`model.objects.filter`, `self.Meta.model.objects.all`):
          // the model is a run-time value, and the manager's name is no table either.
          // Also further down its chain (`self.child_model.objects.restrict(user).filter(…)`).
          if (!table && !instance && /(?:^|\.)objects\.[A-Za-z_]\w*/.test(fnName.replace(/\([^()]*\)/g, "()"))) instance = true;
          // A queryset held in a variable or attribute (`self.queryset.filter(…)` in a generic view,
          // `qs.count()`): its model is what it was assigned — a class attribute
          // `queryset = Club.objects.all()` included — else a run-time value, never a table named `queryset`.
          if (!table && !instance && parts.length >= 2 && /^(?:queryset|qs)$|_(?:queryset|qs)$/i.test(parts[parts.length - 2]!)) {
            const held = parts.slice(0, -1).join(".");
            if (/^(?:self\.)?[a-z_]\w*$/.test(held)) {
              table = heldModel(held, this.sourceText) ?? (held.startsWith("self.") ? heldModel(held.slice(5), this.sourceText) : null);
              instance = !table;
            }
          }
          // A related manager (`doc.tags.all()`) is named after its relation field, never a table:
          // the entity pass resolves the field to the model it relates to.
          const relatedField = !table && !instance && !datastoreChain(fnName) && relatedManager(fnName, leaf) ? parts[parts.length - 2] : undefined;
          // SQLAlchemy names the model in the statement handed over, not in the chain:
          // `session.execute(select(Club)…)`, a local assigned one, `session.query(Club)`.
          // `select(self.model)` names an attribute of the instance, which the project pass resolves.
          let entityAttribute: string | undefined;
          if (!table && !tableRef && !instance && !relatedField) {
            const stated = statementModel(node);
            if (stated?.model) table = stated.model;
            else if (stated?.attribute) entityAttribute = stated.attribute;
            if (stated) access ??= stated.access;
          }
          // Each call of a chain is a row of its own (`query(…).filter(…).first()`): the filter is told once per line.
          const found = pythonWhereFields(node);
          const json = found ? JSON.stringify(found) : "";
          const whereFields = found && !sources.some((d) => d.line === node.startPosition.row + 1 && d.whereFields && JSON.stringify(d.whereFields) === json) ? found : null;
          sources.push(this.ds({
            kind: "database",
            name: fnName,
            target: table ?? tableRef,
            line: node.startPosition.row + 1,
            ...(whereFields ? { whereFields } : {}),
            ...(table ? { entity: table } : tableRef ? { entity: tableRef, targetRef: tableRef } : {}),
            ...(instance ? { receiverIsInstance: true } : {}),
            ...(relatedField ? { relatedField } : {}),
            ...(entityAttribute ? { entityAttribute } : {}),
            ...(access ? { access } : {}),
          }));
        }
      }
    }
  }
}

/**
 * Method leaves that indicate a DB op on any receiver (SQLAlchemy / Django ORM
 * / pymongo / DB-API). `save` stays here: Django's `order.save()` is the write,
 * and a project class's own `save` is dropped once the linker resolves it
 * (`demoteProjectCallDataSources`).
 */
const PY_DB_LEAVES = new Set([
  "callproc", "executemany", "find_one", "find_many", "filter_by", "get_or_create", "save",
  "insert_one", "insert_many", "update_one", "update_many",
  "delete_one", "delete_many", "count_documents",
]);

/** Verbs a model INSTANCE answers (`club.save()`), as opposed to a manager or session. */
const INSTANCE_VERBS = new Set(["save", "delete", "refresh_from_db"]);

/**
 * The model a variable holds, where the file builds it (`self.club1 = Club.objects.create(…)`,
 * `match = Match(home=…)`, `club: Club = …`): unique-or-nothing over every assignment.
 */
function heldModel(held: string, sourceText: string): string | null {
  const name = escapeRegex(held);
  const models = new Set<string>();
  for (const m of sourceText.matchAll(new RegExp(String.raw`(?:^|[^\w.])` + name + String.raw`\s*(?::\s*([A-Z]\w*)[^=\n]*)?=\s*(?!=)(?:await\s+)?(?:([A-Z]\w*)(?:\.objects\.\w+)?\s*\()?`, "gm"))) {
    const model = m[1] ?? m[2];
    if (!model) return null; // assigned something the file does not say is a model
    models.add(model);
  }
  return models.size === 1 ? [...models][0]! : null;
}

/** A Django manager's writing verbs; every other manager call reads. */
const DJANGO_WRITE_LEAVES = new Set([
  "create", "bulk_create", "bulk_update", "update", "update_or_create", "get_or_create", "delete", "save",
]);

/** DB verbs that are also ordinary method names — trusted only on a datastore-shaped chain. */
const PY_GENERIC_DB_LEAVES = new Set(["query", "execute", "find", "filter", "all", "first", "aggregate"]);

/**
 * A session handed a statement (`session.scalars(select(Club))`, SQLModel
 * `session.exec(…)`): a datastore call only on the session itself — inside a
 * chain (`session.execute(q).scalars()`) it reads the result already counted.
 */
const PY_SESSION_STATEMENT_LEAVES = new Set(["exec", "scalars", "scalar"]);

/** Datastore calls handed a SQLAlchemy statement (`execute`, `scalars`, SQLModel `exec`) or a model (`query`). */
const PY_STATEMENT_LEAVES = new Set(["execute", "exec", "scalars", "scalar", "query"]);

/**
 * The model a SQLAlchemy call reaches, as the statement handed to the session
 * names it — anywhere down the chain (`session.execute(q).scalars().all()`):
 * `session.query(Club)`, `session.execute(select(Club).where(…))`, a local the
 * function assigns such a statement (every assignment that builds one must
 * agree), `update(Club)` / `delete(Club)` / `insert(Club)` writing. A model
 * held by an attribute of the instance (`select(self.model)`) is returned as
 * that attribute, for the project pass to resolve.
 */
function statementModel(call: Node): { model?: string; attribute?: string; access: "read" | "write" } | null {
  let cur: Node | null = call;
  let handed: Node | null = null;
  while (cur?.type === "call") {
    const fn = cur.childForFieldName("function");
    if (fn?.type !== "attribute") break;
    if (PY_STATEMENT_LEAVES.has(fn.childForFieldName("attribute")?.text ?? "") && datastoreChain(fn.text)) handed = cur;
    cur = fn.childForFieldName("object");
  }
  if (!handed) return null;
  const arg = positional(handed)[0];
  if (!arg) return null;
  if (handed.childForFieldName("function")!.childForFieldName("attribute")!.text === "query") {
    const model = modelExpression(arg);
    return model ? { ...model, access: "read" } : null;
  }
  const found = new Map<string, { model?: string; attribute?: string; access: "read" | "write" }>();
  for (const value of arg.type === "identifier" ? assignedValues(arg.text, handed) : [arg]) {
    const stmt = rootStatement(value);
    if (stmt) found.set(`${stmt.model ?? ""}|${stmt.attribute ?? ""}|${stmt.access}`, stmt);
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

/** `select(Club).where(…).order_by(…)` → the model `select` is given; null for any other expression. */
function rootStatement(expr: Node): { model?: string; attribute?: string; access: "read" | "write" } | null {
  let cur: Node = expr;
  while (cur.type === "call") {
    const fn = cur.childForFieldName("function");
    const inner = fn?.type === "attribute" ? fn.childForFieldName("object") : null;
    if (inner?.type !== "call") break;
    cur = inner;
  }
  if (cur.type !== "call") return null;
  const verb = /^(?:[a-z_]\w*\.)*(select|insert|update|delete)$/.exec(cur.childForFieldName("function")?.text ?? "")?.[1];
  const first = verb ? positional(cur)[0] : undefined;
  const model = first ? modelExpression(first) : null;
  return model ? { ...model, access: verb === "select" ? "read" : "write" } : null;
}

/** `Club`, `models.Club`, `Club.id` → the class; `self.model` / `self.model.id` → the attribute. */
function modelExpression(node: Node): { model?: string; attribute?: string } | null {
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(node.text)) return null;
  const parts = node.text.split(".");
  if ((parts[0] === "self" || parts[0] === "cls") && parts.length >= 2 && parts.length <= 3 && /^[a-z_]/.test(parts[1]!)) return { attribute: parts[1]! };
  const at = parts.findIndex((p) => /^[A-Z]/.test(p));
  // A module path before the class (`models.Club`), a column after it (`Club.id`) — never a member of a member.
  if (at < 0 || parts.slice(0, at).some((p) => !/^[a-z_]/.test(p)) || parts.length - at > 2) return null;
  return { model: parts[at]! };
}

/** Every value the function enclosing `at` assigns to `name` (nested functions aside); none when it rebinds it otherwise. */
function assignedValues(name: string, at: Node): Node[] {
  let scope: Node | null = at.parent;
  while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
  if (!scope) return [];
  const out: Node[] = [];
  let other = false;
  const visit = (n: Node): void => {
    if (n !== scope && (n.type === "function_definition" || n.type === "class_definition")) return;
    if (n.type === "assignment" && n.childForFieldName("left")?.text === name) {
      const right = n.childForFieldName("right");
      if (right) out.push(right);
    } else if ((n.type === "augmented_assignment" || n.type === "for_statement") && n.childForFieldName("left")?.text === name) {
      other = true;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(scope);
  return other ? [] : out;
}

/** A receiver segment that names a datastore handle or an ORM query. */
const PY_DATASTORE_SEGMENT_RE = /(^|_)(session|db|con|conn|connection|cursor|cur|engine|collection|coll|database|queryset|qs)$/i;

/**
 * A Django related manager queried — `user.orders.all()`,
 * `self.items.filter(...)`: a set-returning verb on an attribute of an object
 * (two or more plain names). A single receiver (`mask.all()`, `ast.filter`)
 * is any other object's method.
 */
function relatedManager(fnName: string, leaf: string): boolean {
  return (leaf === "all" || leaf === "first" || leaf === "filter") &&
    /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){2,}$/.test(fnName);
}

/** `Order.objects.filter(…).first` / `User.query.filter_by` → the capitalised model before the manager. */
function managerModel(fnName: string): string | null {
  const m = /(?:^|\.)([A-Z]\w*)\.(?:objects|query)\./.exec(fnName.replace(/\([^()]*\)/g, "()"));
  return m ? m[1]! : null;
}

/**
 * Does the receiver chain of `fnName` (leaf dropped) show a datastore? A
 * segment shaped like a session/cursor/collection, a Django manager
 * (`Order.objects.filter`), or a SQLAlchemy query (`session.query(User).first`,
 * Flask-SQLAlchemy `User.query.filter_by`).
 */
function datastoreChain(fnName: string): boolean {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < fnName.length; i++) {
    const c = fnName[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "." && depth === 0) {
      segments.push(fnName.slice(start, i));
      start = i + 1;
    }
  }
  return segments.some((seg) => {
    const name = seg.replace(/[([].*$/s, "").trim();
    return name === "objects" || name === "query" || PY_DATASTORE_SEGMENT_RE.test(name);
  });
}

/**
 * Session/connection-mutating verbs. Plain English words, so they need a
 * DB-shaped receiver before they count.
 */
const PY_SESSION_WRITE_LEAVES = new Set([
  "add", "add_all", "delete", "merge", "commit", "flush", "bulk_save_objects",
]);

/** Receiver names that read as a SQLAlchemy session / DB-API connection. */
const PY_DB_RECEIVER_RE = /(^|_)(session|db|con|conn|connection|cursor|engine)$/i;

/**
 * Read/write classification for the leaves above. `execute`/`executemany` stay
 * unclassified: the statement's verb decides, and it is not visible here.
 */
const PY_DB_ACCESS = dbVerbTable(
  [
    "query", "find", "find_one", "find_many", "filter", "filter_by",
    "all", "first", "count_documents", "aggregate",
  ],
  [
    "insert_one", "insert_many", "update_one", "update_many",
    "delete_one", "delete_many", "save", "get_or_create",
  ],
);

/**
 * Resolve a call argument by keyword (`queue="tasks"`) or position, returning
 * a string literal's unquoted value or any other expression's source text
 * (`config.EXCHANGE` — still a usable join label). Empty-string literals
 * (pika's default exchange) return null.
 */
/** Vector-store client calls that read or write a collection (Qdrant, Chroma, Pinecone, Milvus). */
const PY_VECTOR_READS = /^(?:search|search_batch|query|query_points|query_batch_points|retrieve|scroll|count|recommend|discover|get_collection|get|collection_exists|get_or_create_collection|get_collection|facet)$/;
const PY_VECTOR_WRITES = /^(?:upsert|delete|create_collection|recreate_collection|delete_collection|update_collection|set_payload|overwrite_payload|delete_payload|clear_payload|update_vectors|delete_vectors|batch_update_points|create_payload_index|add|insert|update)$/;

/** `@app.task`, `@celery.task(bind=True)`, `@shared_task` — not a bare `@task` (Invoke, Prefect). */
const CELERY_TASK_RE = /^@\s*(?:[A-Za-z_]\w*\.)+task\b|^@\s*shared_task\b/;

/** `exchange=""` (or `''`) stated on a pika publish: the default exchange. */
function exchangeIsDefault(call: Node): boolean {
  const args = call.childForFieldName("arguments");
  const kw = args?.namedChildren.find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === "exchange");
  const value = kw ? kw.childForFieldName("value") : args?.namedChildren.find((a) => a.type !== "keyword_argument" && a.type !== "comment");
  return !!value && value.type === "string" && /^[rbu]*(['"])\1$/i.test(value.text);
}

/** Module-level `NAME = "x"` and class-level `class Queues: NAME = "x"` (as `Queues.NAME`); a name bound twice is left out. */
function stringConstants(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  const clash = new Set<string>();
  const read = (body: Node, prefix: string): void => {
    for (const stmt of body.namedChildren) {
      if (stmt.type === "class_definition" && !prefix) {
        const name = stmt.childForFieldName("name")?.text;
        const inner = stmt.childForFieldName("body");
        if (name && inner) read(inner, `${name}.`);
        continue;
      }
      if (stmt.type !== "expression_statement") continue;
      const a = stmt.namedChild(0);
      if (a?.type !== "assignment") continue;
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      if (left?.type !== "identifier" || right?.type !== "string" || right.namedChildren.some((c) => c.type === "interpolation")) continue;
      const key = prefix + left.text;
      const value = right.text.replace(/^[rbu]*['"]{1,3}|['"]{1,3}$/gi, "");
      if (out.has(key) && out.get(key) !== value) clash.add(key);
      out.set(key, value);
    }
  };
  read(root, "");
  for (const k of clash) out.delete(k);
  return out;
}

function pyArg(call: Node, keyword: string, index: number): string | null {
  const args = call.childForFieldName("arguments");
  if (!args) return null;
  let value: Node | null = null;
  let positional = 0;
  for (const a of args.namedChildren) {
    if (a.type === "keyword_argument") {
      if (a.childForFieldName("name")?.text === keyword) {
        value = a.childForFieldName("value");
        break;
      }
    } else if (a.type !== "comment") {
      if (positional === index && value === null) value = a;
      positional++;
    }
  }
  if (!value) return null;
  const text = value.type === "string"
    ? value.text.replace(/^[rbfu]*['"]{1,3}|['"]{1,3}$/gi, "")
    : value.text.replace(/\s+/g, " ");
  return text && text.length <= 64 ? text : null;
}

/**
 * A queue or topic named by its URL, ARN or the variable holding it: the URL's
 * last segment, the ARN's, an `os.environ[…]` / `os.getenv(…)` name, or the identifier.
 */
function queueName(raw: string): string | null {
  const env = /os\.(?:environ\[\s*['"]([^'"]+)['"]\s*\]|getenv\(\s*['"]([^'"]+)['"]|environ\.get\(\s*['"]([^'"]+)['"])/.exec(raw);
  if (env) return env[1] ?? env[2] ?? env[3]!;
  if (/^[A-Za-z_][\w.]*$/.test(raw)) return raw.split(".").pop()!;
  const last = raw.split(/[/:]/).filter(Boolean).pop();
  return last && /^[\w.-]+$/.test(last) ? last : null;
}

/** HTTP client modules whose verb functions are always outbound calls. */
const PY_HTTP_MODULES = new Set(["requests", "httpx", "aiohttp"]);
const PY_HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
/** A client/session object (`session.get`, `self.client.post`) — an HTTP call only with a URL-shaped argument. */
const PY_HTTP_RECEIVER_RE = /(^|_)(session|client|http)$/i;

/**
 * An outbound HTTP call, decided on the call's SHAPE rather than on a substring
 * of its text. The old substring test (`fnName.includes("requests.")`) read
 * `pending_requests.get("task_type")`, `httpx.Response(200)` and
 * `requests.get(url).json().get("page")` as HTTP calls, with the first
 * argument's raw text — a variable name, a status code — as the URL.
 *
 * Accepted: `<module>.<verb>(…)` on requests / httpx / aiohttp, and
 * `<module>.request(VERB, url)`; or a verb on a session/client receiver whose
 * first argument is a URL-shaped string. The target is a string literal's
 * content (an f-string keeps its `{holes}`), else null — a variable's name is
 * not a URL.
 */
function httpCall(fn: Node, call: Node): { name: string; target: string | null } | null {
  if (fn.type !== "attribute") return null;
  const leaf = fn.childForFieldName("attribute")?.text ?? "";
  const obj = fn.childForFieldName("object");
  if (!obj) return null;
  const args = call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "keyword_argument") ?? [];
  const recv = obj.type === "identifier" ? obj.text : obj.type === "attribute" ? obj.childForFieldName("attribute")?.text ?? "" : "";

  if (obj.type === "identifier" && PY_HTTP_MODULES.has(recv)) {
    // Named by its verb, as a client receiver's call is: the route linker reads the method off the name.
    if (PY_HTTP_VERBS.has(leaf)) return { name: leaf, target: args[0] ? pyStringValue(args[0], call) : null };
    if (leaf === "request") {
      const method = pyStringLiteral(args[0]);
      return method && PY_HTTP_VERBS.has(method.toLowerCase())
        ? { name: method.toLowerCase(), target: args[1] ? pyStringValue(args[1], call) : null }
        : null;
    }
    return null;
  }
  if (PY_HTTP_VERBS.has(leaf) && PY_HTTP_RECEIVER_RE.test(recv)) {
    // A literal, or a local the function builds it in (`url = f"http://{BASE}/api/x"`).
    const target = args[0] ? pyStringValue(args[0], call) : null;
    if (target && (target.includes("/") || /^https?:/i.test(target))) return { name: leaf, target };
  }
  // A verb on a local the code made an HTTP client: `session = requests.Session()` — in this
  // function or one it is nested in — whatever the URL argument is.
  if (PY_HTTP_VERBS.has(leaf) && obj.type === "identifier") {
    const made = boundValue(recv, call);
    const typed = made ? null : annotatedParam(recv, call);
    if ((made?.type === "call" && PY_HTTP_CLIENT_CTOR.test(made.childForFieldName("function")?.text ?? "")) || (typed && PY_HTTP_CLIENT_TYPE.test(typed))) {
      return { name: leaf, target: args[0] ? pyStringValue(args[0], call) ?? moduleValueHole(args[0]) : null };
    }
  }
  return null;
}

/** An HTTP client's type as a parameter annotates it: Starlette / FastAPI `TestClient`, `httpx.Client`. */
const PY_HTTP_CLIENT_TYPE = /^(?:[\w.]+\.)?(?:TestClient|Client|AsyncClient|ClientSession|Session)$/;

/** The annotation of the parameter `name` of the function `at` sits in (`api_client: TestClient`), as written. */
function annotatedParam(name: string, at: Node): string | null {
  let fn: Node | null = at.parent;
  while (fn && fn.type !== "function_definition") fn = fn.parent;
  for (const p of fn?.childForFieldName("parameters")?.namedChildren ?? []) {
    if ((p.type === "typed_parameter" || p.type === "typed_default_parameter") && (p.namedChild(0)?.text ?? p.childForFieldName("name")?.text) === name) {
      return p.childForFieldName("type")?.text.trim() ?? null;
    }
  }
  return null;
}

/**
 * A URL another module defines, named by the argument (`api_routes.recipes_url`), or a
 * URL helper's call (`api_routes.recipes_slug(slug)`): a `${…}` hole the project pass fills.
 */
function moduleValueHole(arg: Node): string | null {
  if ((arg.type === "attribute" || arg.type === "identifier") && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){0,2}$/.test(arg.text)) return `\${${arg.text}}`;
  const fn = arg.type === "call" ? arg.childForFieldName("function")?.text ?? "" : "";
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(fn) && !arg.text.includes("\n") ? `\${${arg.text.replace(/\s+/g, " ")}}` : null;
}

/** The constructors of an HTTP client object. */
const PY_HTTP_CLIENT_CTOR = /^(?:requests\.(?:Session|session)|httpx\.(?:Client|AsyncClient)|aiohttp\.ClientSession|Session|ClientSession|TestClient)$/;

/**
 * The value `name` is bound to where `at` reads it: its one assignment in the
 * enclosing function, else — a name the function never assigns — in the
 * function it is nested in, out to the module (a closure reads its outer locals).
 */
function boundValue(name: string, at: Node): Node | null {
  let scope: Node | null = at.parent;
  while (scope) {
    while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
    if (!scope) return null;
    let found: Node | null = null;
    let count = 0;
    const root = scope;
    const visit = (n: Node): void => {
      if (count > 1) return;
      if (n !== root && (n.type === "function_definition" || n.type === "class_definition")) return;
      const left = n.type === "assignment" || n.type === "augmented_assignment" || n.type === "for_statement" ? n.childForFieldName("left")?.text : undefined;
      if (left === name) {
        count += n.type === "assignment" ? 1 : 2;
        found = n.type === "assignment" ? n.childForFieldName("right") : null;
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(root);
    const params = root.type === "function_definition" ? root.childForFieldName("parameters")?.namedChildren ?? [] : [];
    if (params.some((p) => (p.type === "identifier" ? p.text : p.childForFieldName("name")?.text ?? p.namedChildren[0]?.text) === name)) return null;
    if (count === 1) return found;
    if (count > 1 || root.type === "module") return null;
    scope = root.parent;
  }
  return null;
}

/** `urlopen` as urllib spells it: bare (imported), or through `urllib.request` / `request` / Python 2's `urllib2`. */
const URLOPEN_RE = /^(?:(?:urllib\.)?request\.|urllib2\.)?urlopen$/;
/** `Request` as urllib spells it. */
const URLLIB_REQUEST_RE = /^(?:(?:urllib\.)?request\.|urllib2\.)?Request$/;

/**
 * `urlopen(url)` / `urlopen(Request(url, data=…, method="POST"))`, the
 * Request built inline or held in a local assigned once. The method is the
 * Request's `method=`, else POST when a body is passed (`data=`, or the second
 * positional argument) — urllib's own rule — else GET.
 */
function urlopenCall(fn: Node, call: Node): { name: string; target: string | null } | null {
  if (!URLOPEN_RE.test(fn.text)) return null;
  let arg: Node | undefined = positional(call)[0] ?? keywordArg(call, "url") ?? undefined;
  if (!arg) return null;
  if (arg.type === "identifier") {
    const held = singleAssignment(arg.text, call);
    if (held?.type === "call") arg = held;
  }
  let request = call;
  if (arg.type === "call" && URLLIB_REQUEST_RE.test(arg.childForFieldName("function")?.text ?? "")) {
    request = arg;
    arg = positional(arg)[0] ?? keywordArg(arg, "url") ?? undefined;
    if (!arg) return null;
  }
  const method = request !== call ? pyStringLiteral(keywordArg(request, "method") ?? undefined) : null;
  const hasBody = !!keywordArg(request, "data") || positional(request).length > 1;
  const name = (method && PY_HTTP_VERBS.has(method.toLowerCase()) ? method : hasBody ? "post" : "get").toLowerCase();
  return { name, target: pyStringValue(arg, call) };
}

/** A call's keyword argument value, by keyword. */
function keywordArg(call: Node, keyword: string): Node | null {
  for (const a of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === keyword) return a.childForFieldName("value");
  }
  return null;
}

/**
 * A URL that starts with a base the file states once, written out as an
 * absolute URL: `{self.base_url}` where the class assigns `self.base_url =
 * f"https://{domain}/rest/api/2"` (or a class attribute `base_url = …`), or
 * `{BASE_URL}` where the module assigns `BASE_URL = "https://…"`. The base's
 * origin is the call's literal base and its path leads the target, so the
 * call reaches that host — never an unknown base the route linker guesses
 * at. Null when the base is assigned more than once, from anything but a
 * string, or to a relative path.
 */
function statedBase(target: string, at: Node): { origin: string; target: string } | null {
  // `{self.base}`, or a module value's `${BASE}` hole.
  const m = /^\$?\{(self\.)?([A-Za-z_]\w*)\}/.exec(target);
  if (!m) return null;
  const rest = target.slice(m[0].length);
  if (rest && !/^[/?#]/.test(rest)) return null;
  const value = m[1] ? selfAttributeValue(m[2]!, at) : moduleConstantValue(m[2]!, at);
  const url = value ? /^(https?:\/\/[^/?#\s]+)([^?#\s]*)$/i.exec(value) : null;
  if (!url) return null;
  const path = url[2]!.replace(/\/+$/, "") + rest;
  return { origin: url[1]!, target: path.startsWith("/") ? path : `/${path}` };
}

/**
 * A URL that starts with an app path the class or module states once
 * (`f"{self.ENDPOINT}1/"` with the class attribute `ENDPOINT = "/api/config/"`):
 * the path written out. Null when the value is no app path or is assigned more than once.
 */
function statedPath(target: string, at: Node): string | null {
  const m = /^\$?\{(self\.)?([A-Za-z_]\w*)\}/.exec(target);
  if (!m) return null;
  const value = m[1] ? selfAttributeValue(m[2]!, at) : moduleConstantValue(m[2]!, at);
  return value && value.startsWith("/") && !/[{}]/.test(value) ? value + target.slice(m[0].length) : null;
}

/** The one string the class enclosing `at` gives `self.<name>` (in any method) or its class attribute `<name>`. */
function selfAttributeValue(name: string, at: Node): string | null {
  let cls: Node | null = at.parent;
  while (cls && cls.type !== "class_definition") cls = cls.parent;
  const body = cls?.childForFieldName("body");
  if (!body) return null;
  const values = new Set<string | null>();
  const visit = (n: Node, inMethod: boolean): void => {
    if (n.type === "class_definition") return;
    if (n.type === "assignment" || n.type === "augmented_assignment") {
      const left = n.childForFieldName("left")?.text;
      if (left === `self.${name}` || (!inMethod && left === name)) {
        const right = n.childForFieldName("right");
        values.add(n.type === "assignment" && right ? pyStringValue(right, right) : null);
      }
    }
    for (const c of n.namedChildren) visit(c, inMethod || n.type === "function_definition");
  };
  for (const c of body.namedChildren) visit(c, false);
  return values.size === 1 ? [...values][0]! : null;
}

/** The one string the module assigns `<name>` at top level, when no function enclosing `at` binds the name itself. */
function moduleConstantValue(name: string, at: Node): string | null {
  const binds = new RegExp(`\\b${name}\\b`);
  let scope: Node | null = at.parent;
  let module: Node | null = null;
  for (; scope; scope = scope.parent) {
    if (scope.type === "function_definition" && binds.test(scope.childForFieldName("parameters")?.text ?? "")) return null;
    if (scope.type === "module") module = scope;
  }
  if (!module) return null;
  const values = new Set<string | null>();
  const visit = (n: Node, nested: boolean): void => {
    if (n.type === "assignment" || n.type === "augmented_assignment" || n.type === "global_statement") {
      const left = n.type === "global_statement" ? null : n.childForFieldName("left")?.text;
      if (n.type === "global_statement" ? binds.test(n.text) : left === name) {
        const right = n.childForFieldName("right");
        // Assigned inside a function: a local of that function, unless it is the one enclosing the call.
        if (!nested) values.add(n.type === "assignment" && right ? pyStringValue(right, right) : null);
        else if (n.type === "global_statement" || isAncestor(enclosingFunction(n), at)) values.add(null);
      }
    }
    for (const c of n.namedChildren) visit(c, nested || n.type === "function_definition" || n.type === "class_definition");
  };
  for (const c of module.namedChildren) visit(c, false);
  return values.size === 1 ? [...values][0]! : null;
}

function enclosingFunction(n: Node): Node | null {
  let p: Node | null = n.parent;
  while (p && p.type !== "function_definition") p = p.parent;
  return p;
}

function isAncestor(a: Node | null, n: Node): boolean {
  for (let p: Node | null = n; a && p; p = p.parent) if (p.id === a.id) return true;
  return false;
}

/**
 * The body a `requests`/`httpx` call states as `json={...}` (a dict literal,
 * or a name bound to one in the enclosing function), typed by literal values.
 */
function jsonBody(call: Node): JsonSchemaNode | null {
  let value: Node | null = null;
  for (const a of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === "json") value = a.childForFieldName("value");
  }
  if (value?.type === "identifier") value = pyLocalValue(value);
  return value?.type === "dictionary" ? dictSchema(value, 0) : null;
}

function dictSchema(d: Node, depth: number): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  let open = false;
  for (const c of d.namedChildren) {
    if (c.type === "pair") {
      const key = pyStringLiteral(c.childForFieldName("key") ?? undefined);
      if (key !== null) properties[key] = pyValueSchema(c.childForFieldName("value"), depth);
      else open = true;
    } else if (c.type === "dictionary_splat") open = true;
  }
  return { type: "object", properties, ...(open ? { additionalProperties: true } : {}) };
}

function pyValueSchema(v: Node | null, depth: number): JsonSchemaNode {
  if (!v || depth > 4) return {};
  switch (v.type) {
    case "string": return { type: "string" };
    case "integer": return { type: "integer" };
    case "float": return { type: "number" };
    case "true": case "false": return { type: "boolean" };
    case "none": return { nullable: true };
    case "list": { const f = v.namedChildren[0]; return { type: "array", ...(f ? { items: pyValueSchema(f, depth + 1) } : {}) }; }
    case "dictionary": return dictSchema(v, depth + 1);
    default: return {};
  }
}

/** The value last assigned to a bare name earlier in the enclosing function (or module). */
function pyLocalValue(name: Node): Node | null {
  let scope: Node | null = name.parent;
  while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
  if (!scope) return null;
  let found: Node | null = null;
  const visit = (n: Node): void => {
    if (n.startIndex >= name.startIndex) return;
    if (n !== scope && n.type === "function_definition") return;
    if (n.type === "assignment" && n.childForFieldName("left")?.text === name.text) found = n.childForFieldName("right");
    for (const c of n.namedChildren) visit(c);
  };
  visit(scope);
  return found;
}

/** Content of a string literal or f-string (`{holes}` kept), else null. */
function pyStringLiteral(node: Node | undefined): string | null {
  if (!node || node.type !== "string") return null;
  const m = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(node.text);
  return m ? m[2]! : null;
}

/** DB-API / SQLAlchemy calls whose first argument is the SQL text. */
const SQL_TEXT_LEAVES = new Set(["execute", "executemany", "executescript", "raw", "exec"]);

/** A call's positional arguments, in order. */
function positional(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "keyword_argument" && a.type !== "comment");
}

/**
 * The text a string-valued expression holds, as far as the source says:
 * a literal (an f-string keeps its `{holes}`), a `+` of literals and names (a
 * name that resolves contributes its text, any other part a `{}` hole), or a
 * local name assigned exactly once in the enclosing function from one of
 * those (`url = f"{BASE}/users/{id}"; requests.get(url)`). Null when the
 * expression carries no literal text at all.
 */
export function pyStringValue(node: Node, at: Node, depth = 0): string | null {
  if (depth > 3) return null;
  if (node.type === "string") {
    const text = pyStringLiteral(node);
    // An f-string's `{name}` hole naming a local the function builds as a string
    // (`base = f"/api/clubs/{club['id']}"`, then `f"{base}/players"`) holds that text.
    if (text === null || !/^[a-zA-Z]*[fF]/.test(node.text)) return text;
    // A function's own local holds its text; a module's value or an imported one
    // (`{CLUBS_URL}`, `{urls.BASE}`) is a `${…}` hole the project pass fills
    // from the module defining it — or splits off as the base when none does.
    let fn: Node | null = at.parent;
    while (fn && fn.type !== "function_definition" && fn.type !== "module") fn = fn.parent;
    const inFunction = fn?.type === "function_definition";
    return text.replace(/\{([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}/g, (hole, name: string) => {
      const value = inFunction && !name.includes(".") ? singleAssignment(name, at) : null;
      const local = value ? pyStringValue(value, value, depth + 1) : null;
      if (local !== null) return local;
      return moduleBound(name, at) ? `\${${name}}` : hole;
    });
  }
  if (node.type === "concatenated_string") {
    const parts = node.namedChildren.map((c) => pyStringValue(c, at, depth + 1));
    return parts.every((p) => p !== null) ? parts.join("") : null;
  }
  if (node.type === "parenthesized_expression" && node.namedChild(0)) return pyStringValue(node.namedChild(0)!, at, depth + 1);
  if (node.type === "binary_operator" && node.childForFieldName("operator")?.text === "+") {
    const l = node.childForFieldName("left");
    const r = node.childForFieldName("right");
    // A long chain nests to the left (`((base + "/a") + x) + "&b"`): only a hop through a name counts toward the depth.
    const lv = l ? pyStringValue(l, at, depth) : null;
    const rv = r ? pyStringValue(r, at, depth) : null;
    if (lv === null && rv === null) return null;
    return `${lv ?? "{}"}${rv ?? "{}"}`;
  }
  if (node.type === "identifier") {
    const value = singleAssignment(node.text, at);
    if (value) return pyStringValue(value, value, depth + 1);
    return moduleBound(node.text, at) ? `\${${node.text}}` : null;
  }
  // `Paths.MATCHES`, `urls.BASE`: a value another module (or a class) defines.
  if (node.type === "attribute" && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(node.text)) {
    return moduleBound(node.text, at) ? `\${${node.text}}` : null;
  }
  return null;
}

/** The names each parsed module binds at its top level, per tree. */
const boundByTree = new WeakMap<object, Set<string>>();

/**
 * Whether a name (its head, for `urls.BASE`) is one the module binds — a
 * module-level assignment, an import, a class — and nothing in the enclosing
 * function rebinds: then its value is the module's (or the imported
 * module's), which the project pass reads. `self.x` and a parameter never are.
 */
function moduleBound(name: string, at: Node): boolean {
  const head = name.split(".")[0]!;
  if (head === "self" || head === "cls") return false;
  let names = boundByTree.get(at.tree);
  if (!names) {
    names = new Set<string>();
    const root = at.tree.rootNode;
    for (const stmt of root.namedChildren) {
      if (stmt.type === "class_definition") {
        const n = stmt.childForFieldName("name")?.text;
        if (n) names.add(n);
      } else if (stmt.type === "import_from_statement" || stmt.type === "import_statement") {
        const moduleName = stmt.childForFieldName("module_name");
        for (const c of stmt.namedChildren) {
          if (stmt.type === "import_from_statement" && moduleName && c.startIndex === moduleName.startIndex) continue;
          if (c.type === "aliased_import") {
            const alias = c.childForFieldName("alias")?.text;
            if (alias) names.add(alias);
          } else if (c.type === "dotted_name") names.add(c.text.split(".")[0]!);
        }
      } else if (stmt.type === "expression_statement") {
        const a = stmt.namedChild(0);
        const left = a?.type === "assignment" ? a.childForFieldName("left") : null;
        if (left?.type === "identifier") names.add(left.text);
      }
    }
    boundByTree.set(at.tree, names);
  }
  if (!names.has(head)) return false;
  // A parameter or local of an enclosing function shadows the module's name.
  for (let fn: Node | null = at.parent; fn; fn = fn.parent) {
    if (fn.type !== "function_definition" && fn.type !== "lambda") continue;
    const params = fn.childForFieldName("parameters");
    if (params && new RegExp(`(?:^|[(,*\\s])${head}\\s*(?:[:=,)]|$)`).test(params.text)) return false;
    let rebound = false;
    const visit = (n: Node): void => {
      if (rebound) return;
      if (n !== fn && (n.type === "function_definition" || n.type === "class_definition")) return;
      if ((n.type === "assignment" || n.type === "augmented_assignment" || n.type === "for_statement") && n.childForFieldName("left")?.text === head) rebound = true;
      for (const c of n.namedChildren) visit(c);
    };
    const body = fn.childForFieldName("body");
    if (body) visit(body);
    if (rebound) return false;
  }
  return true;
}

/** The value `name` is assigned in the function enclosing `at`, when it is assigned exactly once there (else null). */
function singleAssignment(name: string, at: Node): Node | null {
  let scope: Node | null = at.parent;
  while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
  if (!scope) return null;
  let found: Node | null = null;
  let count = 0;
  const visit = (n: Node): void => {
    if (count > 1) return;
    if (n !== scope && (n.type === "function_definition" || n.type === "class_definition")) return;
    if (n.type === "assignment" && n.childForFieldName("left")?.text === name) {
      count++;
      found = n.childForFieldName("right");
    } else if ((n.type === "augmented_assignment" || n.type === "for_statement") && n.childForFieldName("left")?.text === name) {
      count += 2;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(scope);
  return count === 1 ? found : null;
}
