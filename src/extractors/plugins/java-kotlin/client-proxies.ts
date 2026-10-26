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
 *   service.getPort(PersonPortType.class)                   (JAX-WS, in a file using javax/jakarta.xml.ws)
 *
 * Only those shapes, each handed exactly one type literal (`X.class`) — a
 * Hibernate `session.createCriteria(X.class)` or a domain
 * `ApplicationFactory.create(X.class)` is not a proxy. An in-house wrapper
 * (`EosRestClientFactory.create(X.class, url)`) counts when it is named like a
 * REST client factory AND handed an address, as does a client builder
 * (`Framework.clientFor(PersonApi.class, url).build()`) or a method named for the proxy it makes
 * (`webClientUtils.createWebClientProxy(PersonApi.class, url)`) handed one. Registered by the type's fully
 * qualified name, from the file's imports or package. A method of the file
 * that hands its `Class<T>` parameter to one of those factories
 * (`<T> T createClient(Class<T> type, Context c) { … JAXRSClientFactory.fromClient(client, type, true) … }`)
 * is a factory too: a call to it with a type literal in that position registers the type.
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
/** An argument naming where the service is: `url`, `serviceURI`, `host` (`@Value("${league.host}") String host`). */
const ADDRESS_ARG = /url|uri|address|endpoint|host|^"https?:\/\//i;

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
  // A JAX-WS `Service` hands out its port (`service.getPort(PortType.class)`): a SOAP client of that port type.
  const jaxws = /\b(?:javax|jakarta)\.xml\.ws\b/.test(sourceText);
  const isKnown = (name: string, object: string) =>
    KNOWN_FACTORIES.some((f) => f.method.test(name) && f.receiver.test(object)) || (jaxws && name === "getPort" && object !== "");
  // The file's own helpers forwarding a `Class<T>` parameter to a known factory: name → that parameter's index.
  const helpers = new Map<string, number>();
  walk(tree.rootNode, (m) => {
    if (m.type !== "method_declaration") return;
    const params = m.childForFieldName("parameters")?.namedChildren.filter((p): p is Node => p?.type === "formal_parameter") ?? [];
    const index = params.findIndex((p) => /^Class\s*</.test(p.childForFieldName("type")?.text ?? ""));
    const param = params[index]?.childForFieldName("name")?.text;
    const name = m.childForFieldName("name")?.text;
    if (!param || !name) return;
    let forwards = false;
    walk(m, (c) => {
      if (forwards || c.type !== "method_invocation") return;
      const args = c.childForFieldName("arguments")?.namedChildren ?? [];
      forwards = isKnown(c.childForFieldName("name")?.text ?? "", c.childForFieldName("object")?.text ?? "") && args.some((a) => a?.text === param);
    });
    if (forwards) helpers.set(name, index);
  });
  const out: HttpClientRegistration[] = [];
  walk(tree.rootNode, (n) => {
    if (n.type !== "method_invocation") return;
    const name = n.childForFieldName("name")?.text ?? "";
    const object = n.childForFieldName("object")?.text ?? "";
    const args = n.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a) ?? [];
    const helper = helpers.get(name);
    if (helper !== undefined && (!object || object === "this") && args[helper]?.type === "class_literal") {
      const fqn = fqnOf(args[helper]!.text.replace(/\.class$/, "").trim());
      if (fqn) out.push({ client: fqn, scope: "project", proxyOf: fqn, line: n.startPosition.row + 1 });
      return;
    }
    const literals = args.filter((a) => a.type === "class_literal");
    if (literals.length !== 1) return;
    const known = isKnown(name, object);
    const addressed = args.some((a) => a.type !== "class_literal" && ADDRESS_ARG.test(a.text));
    // A factory method named for what it makes (`createWebClientProxy(PersonApi.class, url)`) needs no receiver name.
    const wrapper = addressed && ((/^create\w*$/.test(name) && WRAPPER_RECEIVER.test(object)) || /^(?:clientFor|create\w*Proxy)$/.test(name));
    if (!known && !wrapper) return;
    const type = literals[0]!.text.replace(/\.class$/, "").trim();
    const fqn = fqnOf(type);
    if (!fqn) return;
    const url = args.map((a) => (a.type === "string_literal" ? a.text.slice(1, -1) : "")).find((v) => /^https?:\/\//i.test(v));
    out.push({ client: fqn, scope: "project", proxyOf: fqn, ...(url ? { base: { kind: "literal" as const, key: url } } : {}), line: n.startPosition.row + 1 });
  });
  return out;
}
