import type { Node, Tree } from "web-tree-sitter";
import type { CallBaseRef, HttpClientRegistration } from "../../../types/analysis.js";

/**
 * HTTP clients a Python file builds with a base URL — `client = httpx.Client(base_url="http://league-api:8080")`,
 * `self.http = httpx.AsyncClient(base_url=os.environ["LEAGUE_URL"])`, `async with aiohttp.ClientSession(base_url=…) as s`.
 * Each is keyed by the name the request is made through (`client`, `self.http`), which the api-call row carries as
 * its `client`; core's call-origin pass follows that to the base. Only a base the source states is recorded: a
 * literal URL with a host, or an environment variable (with the URL it falls back to). A `requests.Session()` has
 * no base of its own, so it registers nothing.
 */
const CLIENT_CTOR_RE = /^(?:httpx\.(?:Client|AsyncClient)|aiohttp\.ClientSession|requests_toolbelt\.sessions\.BaseUrlSession|BaseUrlSession)$/;
/** Names that are those constructors only when the file imports them from the library. */
const BARE_CTOR_RE = /^(?:Client|AsyncClient|ClientSession|BaseUrlSession)$/;
const BARE_CTOR_IMPORT_RE = /^\s*from\s+(?:httpx|aiohttp|requests_toolbelt(?:\.sessions)?)\s+import\b/m;

/** The receiver of a request, as the registration and the call row both spell it: `client` or `self.http`. */
export function pythonClientKey(receiver: Node | null): string | null {
  if (!receiver) return null;
  if (receiver.type === "identifier") return receiver.text;
  if (receiver.type === "attribute") {
    const obj = receiver.childForFieldName("object");
    const attr = receiver.childForFieldName("attribute");
    if (obj?.type === "identifier" && obj.text === "self" && attr) return `self.${attr.text}`;
  }
  return null;
}

function stringOf(node: Node | null | undefined): string | null {
  if (!node || node.type !== "string") return null;
  if (/^[a-zA-Z]*[fF]/.test(node.text) && node.text.includes("{")) return null;
  const m = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(node.text);
  return m ? m[2]! : null;
}

const hasHost = (url: string | null): url is string => !!url && /^https?:\/\/[^/\s]+/i.test(url);

/** `os.environ["X"]`, `os.environ.get("X", "http://…")`, `os.getenv("X")`, `… or "http://…"` → an env reference. */
function envRefOf(node: Node): CallBaseRef | null {
  if (node.type === "boolean_operator" && node.childForFieldName("operator")?.text === "or") {
    const left = envRefOf(node.childForFieldName("left")!);
    const fallback = stringOf(node.childForFieldName("right"));
    return left ? { ...left, ...(hasHost(fallback) ? { fallback } : {}) } : null;
  }
  if (node.type === "subscript") {
    const value = node.childForFieldName("value")?.text.replace(/\s+/g, "") ?? "";
    const key = stringOf(node.childForFieldName("subscript"));
    return /^(?:os\.)?environ$/.test(value) && key && /^\w+$/.test(key) ? { kind: "env", key } : null;
  }
  if (node.type === "call") {
    const fn = node.childForFieldName("function")?.text.replace(/\s+/g, "") ?? "";
    if (!/^(?:os\.)?(?:environ\.get|getenv)$/.test(fn)) return null;
    const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
    const key = stringOf(args[0]);
    if (!key || !/^\w+$/.test(key)) return null;
    const fallback = stringOf(args[1]);
    return { kind: "env", key, ...(hasHost(fallback) ? { fallback } : {}) };
  }
  return null;
}

function baseRefOf(node: Node | null): CallBaseRef | null {
  if (!node) return null;
  const lit = stringOf(node);
  if (lit !== null) return hasHost(lit) ? { kind: "literal", key: lit } : null;
  return envRefOf(node);
}

/** The `base_url` keyword of the constructor call (`BaseUrlSession` takes it first). */
function baseArg(call: Node, ctor: string): Node | null {
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
  for (const a of args) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === "base_url") return a.childForFieldName("value");
  }
  return /BaseUrlSession$/.test(ctor) && args[0] && args[0].type !== "keyword_argument" ? args[0] : null;
}

function clientCall(value: Node | null, bareOk: boolean): { call: Node; ctor: string } | null {
  let call = value;
  while (call?.type === "await" || call?.type === "parenthesized_expression") call = call.namedChildren[0] ?? null;
  if (call?.type !== "call") return null;
  const ctor = call.childForFieldName("function")?.text.replace(/\s+/g, "") ?? "";
  return CLIENT_CTOR_RE.test(ctor) && (bareOk || !BARE_CTOR_RE.test(ctor)) ? { call, ctor } : null;
}

export function extractPythonHttpClientRegistrations(tree: Tree, sourceText: string): HttpClientRegistration[] {
  if (!sourceText.includes("base_url") && !sourceText.includes("BaseUrlSession")) return [];
  const bareOk = BARE_CTOR_IMPORT_RE.test(sourceText);
  const out: HttpClientRegistration[] = [];
  const add = (target: Node | null, value: Node | null, line: number): void => {
    const key = pythonClientKey(target);
    const made = key ? clientCall(value, bareOk) : null;
    if (!key || !made) return;
    const base = baseRefOf(baseArg(made.call, made.ctor));
    if (base) out.push({ client: key, scope: "file", base, line });
  };
  // How often each name is bound at all: a name also bound to something else (`client = requests.Session()` in
  // another function, `self.http` in two classes) is no one client, and registers nothing.
  const bindings = new Map<string, number>();
  for (const a of tree.rootNode.descendantsOfType("assignment")) {
    if (!a) continue;
    const key = pythonClientKey(a.childForFieldName("left"));
    if (key) bindings.set(key, (bindings.get(key) ?? 0) + 1);
    add(a.childForFieldName("left"), a.childForFieldName("right"), a.startPosition.row + 1);
  }
  for (const p of tree.rootNode.descendantsOfType("as_pattern")) {
    if (!p) continue;
    const alias = p.namedChildren.find((c) => c.type === "as_pattern_target");
    const key = pythonClientKey(alias?.namedChildren[0] ?? null);
    if (key) bindings.set(key, (bindings.get(key) ?? 0) + 1);
    add(alias?.namedChildren[0] ?? null, p.namedChildren[0] ?? null, p.startPosition.row + 1);
  }
  return out.filter((r) => bindings.get(r.client) === out.filter((o) => o.client === r.client).length);
}
