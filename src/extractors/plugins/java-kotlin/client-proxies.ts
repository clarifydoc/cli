import type { Node, Tree } from "web-tree-sitter";
import type { HttpClientRegistration } from "../../../types/analysis.js";

/**
 * REST client proxies built in Java code — an API interface handed to a proxy
 * factory, every call on the result an HTTP request:
 *
 *   RestClient.createClient(PersonApi.class, url)           (in-house wrappers alike)
 *   JAXRSClientFactory.create(url, PersonApi.class)         (CXF)
 *   WebResourceFactory.newResource(PersonApi.class, target) (Jersey)
 *   target.proxy(PersonApi.class)                           (RESTEasy)
 *   RestClientBuilder.newBuilder().baseUri(u).build(PersonApi.class)  (MicroProfile)
 *   Feign.builder().target(PersonApi.class, url)            (Feign)
 *
 * Only those shapes, each handed exactly one type literal (`X.class`) — a
 * Hibernate `session.createCriteria(X.class)` or a domain
 * `ApplicationFactory.create(X.class)` is not a proxy. An in-house wrapper
 * (`EosRestClientFactory.create(X.class, url)`) counts when it is named like a
 * REST client factory AND handed an address, as does a client builder
 * (`Framework.clientFor(PersonApi.class, url).build()`) handed one. Registered by the type's fully
 * qualified name, from the file's imports or package.
 */
const KNOWN_FACTORIES: ReadonlyArray<{ method: RegExp; receiver: RegExp }> = [
  { method: /^createClient$/, receiver: /RestClient|HttpServiceProxyFactory/ },
  { method: /^(?:create|fromClient)$/, receiver: /JAXRSClientFactory/ },
  { method: /^newResource$/, receiver: /WebResourceFactory/ },
  { method: /^proxy$/, receiver: /target$/i },
  { method: /^build$/, receiver: /RestClientBuilder/ },
  { method: /^target$/, receiver: /Feign/ },
];
const WRAPPER_RECEIVER = /Rest\w*Client|ClientFactory|ProxyFactory/;
const ADDRESS_ARG = /url|uri|address|endpoint|^"https?:\/\//i;

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const c of node.namedChildren) if (c) walk(c, visit);
}

export function extractJavaClientProxies(tree: Tree, sourceText: string): HttpClientRegistration[] {
  if (!sourceText.includes(".class")) return [];
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(sourceText)?.[1];
  const fqnOf = (type: string): string | null => {
    if (type.includes(".")) return type;
    const imported = new RegExp(`^\\s*import\\s+([\\w.]+\\.${type})\\s*;`, "m").exec(sourceText)?.[1];
    return imported ?? (pkg ? `${pkg}.${type}` : null);
  };
  const out: HttpClientRegistration[] = [];
  walk(tree.rootNode, (n) => {
    if (n.type !== "method_invocation") return;
    const name = n.childForFieldName("name")?.text ?? "";
    const object = n.childForFieldName("object")?.text ?? "";
    const args = n.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a) ?? [];
    const literals = args.filter((a) => a.type === "class_literal");
    if (literals.length !== 1) return;
    const known = KNOWN_FACTORIES.some((f) => f.method.test(name) && f.receiver.test(object));
    const addressed = args.some((a) => a.type !== "class_literal" && ADDRESS_ARG.test(a.text));
    const wrapper = addressed && ((/^create\w*$/.test(name) && WRAPPER_RECEIVER.test(object)) || /^clientFor$/.test(name));
    if (!known && !wrapper) return;
    const type = literals[0]!.text.replace(/\.class$/, "").trim();
    const fqn = fqnOf(type);
    if (!fqn) return;
    const url = args.map((a) => (a.type === "string_literal" ? a.text.slice(1, -1) : "")).find((v) => /^https?:\/\//i.test(v));
    out.push({ client: fqn, scope: "project", proxyOf: fqn, ...(url ? { base: { kind: "literal" as const, key: url } } : {}), line: n.startPosition.row + 1 });
  });
  return out;
}
