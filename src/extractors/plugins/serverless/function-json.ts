import type { EntryPointInfo, RouteInfo } from "../../../types/analysis.js";
import { azureFunctionPath, azureMethods } from "../shared/azure-functions.js";

/**
 * Azure Functions' v1–v3 model: one folder per function, its `function.json`
 * declaring the trigger and where the code is.
 *
 *   Clubs/function.json
 *   { "scriptFile": "../dist/Clubs/index.js", "entryPoint": "listClubs",
 *     "bindings": [{ "type": "httpTrigger", "direction": "in", "name": "req",
 *                    "methods": ["get"], "route": "clubs/{id?}" }, …] }
 *
 * An `httpTrigger` serves `/<route>` (the folder's name when it states none)
 * under each method it lists — any when none — and host.json's route prefix
 * is the project's route base. The row's `handler` names the code the way a
 * Lambda handler does, relative to the folder (`index.listClubs`, Python's
 * `__init__.main`, a script's `run.Run`, a compiled `Ns.Class::Run`), and the
 * serverless route anchor moves it onto that function. A timer is a scheduled
 * job, a queue / Service Bus / Event Hub trigger a message consumer.
 */

interface Binding {
  type?: unknown;
  direction?: unknown;
  route?: unknown;
  methods?: unknown;
  schedule?: unknown;
  queueName?: unknown;
  topicName?: unknown;
  eventHubName?: unknown;
}

interface FunctionJson {
  scriptFile?: unknown;
  entryPoint?: unknown;
  disabled?: unknown;
  bindings?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseFunctionJson(text: string): FunctionJson | null {
  try {
    const json = JSON.parse(text) as unknown;
    return json && typeof json === "object" && Array.isArray((json as FunctionJson).bindings) ? (json as FunctionJson) : null;
  } catch {
    return null;
  }
}

/** The handler a function folder's code is found by, relative to the folder. */
function handlerOf(fn: FunctionJson): string | null {
  const script = str(fn.scriptFile);
  const entry = str(fn.entryPoint);
  if (script && /\.dll$/i.test(script)) {
    // A compiled assembly: `entryPoint` is `Namespace.Class.Method`.
    if (!entry || !entry.includes(".")) return null;
    const dot = entry.lastIndexOf(".");
    return `${entry.slice(0, dot)}::${entry.slice(dot + 1)}`;
  }
  if (script) {
    const module = script.replace(/^\.\//, "").replace(/\.[^./]+$/, "");
    const lang = /\.py$/i.test(script) ? "python" : /\.csx$/i.test(script) ? "csx" : "js";
    return `${module}.${entry ?? (lang === "python" ? "main" : lang === "csx" ? "Run" : "default")}`;
  }
  // No scriptFile: the runtime's defaults (`index.js`, Python's `__init__.py`, a script's `run.csx`), tried in turn.
  return entry ? `index.${entry}|__init__.${entry}|run.${entry}` : "index.default|__init__.main|run.Run";
}

/** The HTTP routes of one `function.json`, `name` being its folder's. */
export function functionJsonRoutes(text: string, name: string): RouteInfo[] {
  const fn = parseFunctionJson(text);
  if (!fn || fn.disabled === true) return [];
  const out: RouteInfo[] = [];
  const handler = handlerOf(fn);
  const lines = text.split("\n");
  for (const b of fn.bindings as Binding[]) {
    if (!b || String(b.type).toLowerCase() !== "httptrigger") continue;
    const path = azureFunctionPath(str(b.route), name);
    const line = Math.max(1, lines.findIndex((l) => /httpTrigger/i.test(l)) + 1);
    const methods = Array.isArray(b.methods) ? azureMethods(b.methods.filter((m): m is string => typeof m === "string")) : [];
    for (const method of methods.length ? methods : [null]) {
      out.push({ path, httpMethod: method, kind: "api", handler, calls: [], middleware: [], line, owner: name });
    }
  }
  return out;
}

/** A function a clock or a queue runs, from its trigger binding. */
export function functionJsonEntryPoints(text: string, name: string): EntryPointInfo[] {
  const fn = parseFunctionJson(text);
  if (!fn || fn.disabled === true) return [];
  const handler = handlerOf(fn);
  const out: EntryPointInfo[] = [];
  for (const b of fn.bindings as Binding[]) {
    const type = String(b?.type ?? "").toLowerCase();
    const at = { line: 1, framework: "azure-functions", ...(handler ? { handler } : {}) };
    if (type === "timertrigger") out.push({ kind: "scheduled-job", name, ...(str(b.schedule) ? { schedule: str(b.schedule)! } : {}), ...at });
    else if (/^(?:queue|servicebus|eventhub)trigger$/.test(type)) {
      const queue = str(b.queueName) ?? str(b.topicName) ?? str(b.eventHubName);
      if (queue) out.push({ kind: "message-consumer", name: queue, ...at });
    }
  }
  return out;
}
