import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractJavaClientProxies } from "./client-proxies.js";

async function proxies(body: string) {
  const src = `package com.acme.app;
import com.acme.api.PersonApi;
import com.acme.domain.Application;
class C { void m() {
${body}
} }`;
  const tree = await parseSource(src, "java" as any, "C.java");
  return extractJavaClientProxies(tree, src).map(({ line: _l, client: _c, scope: _s, ...r }) => r);
}

describe("Java client proxies", () => {
  it("reads the proxy factories of CXF, Jersey, RESTEasy, MicroProfile and Feign", async () => {
    expect(await proxies(`
RestClient.createClient(PersonApi.class, url);
JAXRSClientFactory.create("http://person:8080", PersonApi.class);
WebResourceFactory.newResource(PersonApi.class, target);
webTarget.proxy(PersonApi.class);
RestClientBuilder.newBuilder().baseUri(uri).build(PersonApi.class);
Feign.builder().target(PersonApi.class, "http://person:8080");`)).toEqual([
      { proxyOf: "com.acme.api.PersonApi" },
      { proxyOf: "com.acme.api.PersonApi", base: { kind: "literal", key: "http://person:8080" } },
      { proxyOf: "com.acme.api.PersonApi" },
      { proxyOf: "com.acme.api.PersonApi" },
      { proxyOf: "com.acme.api.PersonApi" },
      { proxyOf: "com.acme.api.PersonApi", base: { kind: "literal", key: "http://person:8080" } },
    ]);
  });

  it("reads a factory method named for the proxy it makes, on any receiver, when handed an address", async () => {
    expect(await proxies(`
webClientUtils.createWebClientProxy(PersonApi.class, loadBalancerURL + serviceURI, ContextAccessor.get());
helper.createProxy(Application.class, defaults);`)).toEqual([{ proxyOf: "com.acme.api.PersonApi" }]);
  });

  it("reads an in-house REST client factory only when it is handed an address", async () => {
    expect(await proxies(`
EosRestClientFactory.createWithAPIFriendlyProviders(SchoolSelectionApi.class, getSchoolSelectionRestURL());
EosRestClientFactory.create(Settings.class, defaults);`)).toEqual([{ proxyOf: "com.acme.app.SchoolSelectionApi" }]);
  });

  it("reads a client builder handed an address", async () => {
    expect(await proxies(`
Framework.clientFor(PersonApi.class, url).withTimeout(30, SECONDS).build();
Framework.clientFor(Settings.class, defaults);`)).toEqual([{ proxyOf: "com.acme.api.PersonApi" }]);
  });

  it("reads nothing into factories that are not proxies", async () => {
    expect(await proxies(`
sessionFactory.getCurrentSession().createCriteria(Application.class);
ApplicationFactory.create(Application.class, input);
objectMapper.readValue(json, PersonApi.class);
ProxyUtil.deproxy(owner, Application.class);`)).toEqual([]);
  });

  it("registers the type handed to a helper of the file that forwards its Class parameter to a factory", async () => {
    const src = `package com.example.league.client;
import com.example.league.api.ClubApi;
class ClubClientImpl {
  public Club find(String id) { return createClient(ClubApi.class, context).getClub(id); }
  public Kit kit(String id) { return this.lookup(KitMapper.class, id); }
  private <T> T createClient(Class<T> type, Context context) {
    WebClient client = WebClient.create(address);
    T proxy = JAXRSClientFactory.fromClient(client, type, true);
    return proxy;
  }
  private <T> T lookup(Class<T> type, String id) { return mapper.read(type, id); }
}`;
    const tree = await parseSource(src, "java" as any, "ClubClientImpl.java");
    expect(extractJavaClientProxies(tree, src).map((r) => [r.proxyOf, r.line])).toEqual([["com.example.league.api.ClubApi", 4]]);
  });
});
