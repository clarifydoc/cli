import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractJavaClientProxies } from "./client-proxies.js";

async function proxies(body: string) {
  const src = `package com.acme.app;
import com.acme.api.PlayerApi;
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
RestClient.createClient(PlayerApi.class, url);
JAXRSClientFactory.create("http://player:8080", PlayerApi.class);
WebResourceFactory.newResource(PlayerApi.class, target);
webTarget.proxy(PlayerApi.class);
RestClientBuilder.newBuilder().baseUri(uri).build(PlayerApi.class);
Feign.builder().target(PlayerApi.class, "http://player:8080");`)).toEqual([
      { proxyOf: "com.acme.api.PlayerApi" },
      { proxyOf: "com.acme.api.PlayerApi", base: { kind: "literal", key: "http://player:8080" } },
      { proxyOf: "com.acme.api.PlayerApi" },
      { proxyOf: "com.acme.api.PlayerApi" },
      { proxyOf: "com.acme.api.PlayerApi" },
      { proxyOf: "com.acme.api.PlayerApi", base: { kind: "literal", key: "http://player:8080" } },
    ]);
  });

  it("reads a factory method named for the proxy it makes, on any receiver, when handed an address", async () => {
    expect(await proxies(`
leagueClientUtils.createWebClientProxy(PlayerApi.class, loadBalancerURL + serviceURI, MatchContext.get());
helper.createProxy(Application.class, defaults);`)).toEqual([{ proxyOf: "com.acme.api.PlayerApi" }]);
  });

  it("reads an in-house REST client factory only when it is handed an address", async () => {
    expect(await proxies(`
LeagueRestClientFactory.createWithAPIFriendlyProviders(TransferApi.class, getTransferRestURL());
LeagueRestClientFactory.create(Settings.class, defaults);`)).toEqual([{ proxyOf: "com.acme.app.TransferApi" }]);
  });

  it("reads a client builder handed an address", async () => {
    expect(await proxies(`
Framework.clientFor(PlayerApi.class, url).withTimeout(30, SECONDS).build();
Framework.clientFor(LeagueApi.class, host).useMatchLog(true).build();
Framework.clientFor(Settings.class, defaults);`)).toEqual([{ proxyOf: "com.acme.api.PlayerApi" }, { proxyOf: "com.acme.app.LeagueApi" }]);
  });

  it("reads nothing into factories that are not proxies", async () => {
    expect(await proxies(`
sessionFactory.getCurrentSession().createCriteria(Application.class);
SquadFactory.create(Application.class, input);
objectMapper.readValue(json, PlayerApi.class);
SquadUtil.deproxy(owner, Application.class);`)).toEqual([]);
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

  it("reads a JAX-WS port as a SOAP client of its port type, only in a file using JAX-WS", async () => {
    const soap = `package com.acme.registry;
import jakarta.xml.ws.BindingProvider;
import com.acme.transfers.TransferPortType;
class TransferClient {
  private final TransferService service = new TransferService();
  Transfer lookup(String id) {
    TransferPortType port = service.getPort(TransferPortType.class);
    ((BindingProvider) port).getRequestContext().put(BindingProvider.ENDPOINT_ADDRESS_PROPERTY, endpoint);
    return port.getData(id);
  }
}`;
    const tree = await parseSource(soap, "java" as any, "TransferClient.java");
    expect(extractJavaClientProxies(tree, soap).map((r) => r.proxyOf)).toEqual(["com.acme.transfers.TransferPortType"]);
    expect(await proxies(`server.getPort(PlayerApi.class);`)).toEqual([]);
  });
});
