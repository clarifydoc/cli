import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Spring services calling each other: a league service serving its routes
 * under a configured context path, and a fan site calling it.
 */
const POM = (name: string) =>
  `<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>${name}</artifactId><version>1</version>
<dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
<dependency><groupId>org.springframework.cloud</groupId><artifactId>spring-cloud-starter-openfeign</artifactId></dependency></dependencies></project>`;

const FILES: Record<string, string> = {
  "docker-compose.yml": `services:
  league:
    build: ./league
    ports: ["8085:8085"]
  gateway:
    build: ./gateway
    ports: ["8080:8080"]
`,
  "gateway/pom.xml": POM("gateway"),
  "gateway/src/main/resources/application.yml": `spring:
  application:
    name: gateway
  cloud:
    gateway:
      routes:
        - id: clubs
          uri: lb://league
          predicates:
            - Path=/api/clubs/**
          filters:
            - RewritePath=/api/clubs/(?<rest>.*), /league/clubs/\${rest}
`,
  "gateway/src/main/java/com/example/gateway/GatewayApp.java": `package com.example.gateway;
public class GatewayApp {}
`,
  "fans/src/main/java/com/example/fans/Scoreboard.java": `package com.example.fans;
import org.springframework.web.client.RestTemplate;
public class Scoreboard {
  private final RestTemplate rest = new RestTemplate();
  public String club(String id) { return rest.getForObject("http://gateway:8080/api/clubs/" + id, String.class); }
}
`,
  "league/pom.xml": POM("league"),
  "league/src/main/resources/application.yml": `spring:
  application:
    name: league
server:
  port: 8085
  servlet:
    context-path: /league
`,
  // A profile's own base never decides where production routes live.
  "league/src/main/resources/application-local.yml": `server:
  servlet:
    context-path: /local-league
`,
  "league/src/main/java/com/example/league/ClubController.java": `package com.example.league;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/clubs")
public class ClubController {
  @GetMapping("/{id}") public String get(@PathVariable String id) { return id; }
  @PostMapping("/{id}/players") public String add(@PathVariable String id) { return id; }
  @PutMapping("/{id}/kits") public String kits(@PathVariable String id) { return id; }
  @DeleteMapping("/{id}") public void remove(@PathVariable String id) { }
}
`,
  "fans/pom.xml": POM("fans"),
  "fans/src/main/java/com/example/fans/ClubClient.java": `package com.example.fans;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;
@FeignClient(name = "league", path = "/league/clubs")
public interface ClubClient {
  @DeleteMapping("/{id}") void remove(@PathVariable("id") String id);
}
`,
  "fans/src/main/java/com/example/fans/KitClient.java": `package com.example.fans;
import org.springframework.web.service.annotation.*;
import org.springframework.web.bind.annotation.PathVariable;
@HttpExchange("http://league:8085/league/clubs")
public interface KitClient {
  @PutExchange("/{id}/kits") String setKits(@PathVariable String id);
}
`,
  "fans/src/main/java/com/example/fans/ClubCalls.java": `package com.example.fans;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.client.RestClient;
import org.apache.http.client.methods.HttpDelete;
public class ClubCalls {
  private final WebClient web = WebClient.builder().baseUrl("http://league:8085/league").build();
  private final RestClient rest = RestClient.create("http://league:8085/league");
  public void run(CloseableHttpClient http) throws Exception {
    web.get().uri("/clubs/{id}", 7).retrieve().bodyToMono(String.class).block();
    rest.post().uri("/clubs/{id}/players", 7).retrieve().body(String.class);
    http.execute(new HttpDelete("http://league:8085/league/clubs/7"));
  }
}
`,
  "fans/src/main/java/com/example/fans/TransferClient.java": `package com.example.fans;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;
@FeignClient("transfers")
public interface TransferClient {
  @GetMapping("/transfers/{id}") String get(@PathVariable("id") String id);
}
`,
  "fans/src/main/java/com/example/fans/Stand.java": `package com.example.fans;
public class Stand {
  private ClubClient clubs;
  public void leave() { clubs.remove("7"); }
}
`,
};

describe("Spring services joined across a context path", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-spring-joins-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves every route under the context path, saying where it is set", () => {
    const routes = summary.routeMap.filter((r) => (r.filePath ?? "").startsWith("league/")).map((r) => `${r.httpMethod} ${r.path}`).sort();
    expect(routes).toEqual(["DELETE /league/clubs/{id}", "GET /league/clubs/{id}", "POST /league/clubs/{id}/players", "PUT /league/clubs/{id}/kits"]);
    expect(summary.routeMap.find((r) => r.httpMethod === "GET")?.basePath).toEqual({
      path: "/league",
      key: "server.servlet.context-path",
      file: "league/src/main/resources/application.yml",
    });
    // The Feign interface declares calls, not routes.
    expect(summary.routeMap.filter((r) => (r.filePath ?? "").startsWith("fans/"))).toEqual([]);
  });

  it("links a Feign call naming the context path to the route", () => {
    const links = (summary.apiRouteLinks ?? []).map((l) => `${l.source}:${l.sourceLine} ${l.method} ${l.routePath} -> ${l.target}`);
    expect(links).toContain("fans/src/main/java/com/example/fans/ClubClient.java:6 DELETE /league/clubs/{id} -> league/src/main/java/com/example/league/ClubController.java");
  });

  it("follows a call through a Spring Cloud Gateway route to the service and path it forwards to", () => {
    const call = summary.apiCalls.find((c) => c.filePath.endsWith("Scoreboard.java"));
    expect(call?.origin).toMatchObject({ host: "league", confidence: "EXTRACTED" });
    expect(call?.origin?.evidence.filter((e) => e.step === "proxy").map((e) => e.file)).toEqual(["gateway/src/main/resources/application.yml"]);
    const link = (summary.apiRouteLinks ?? []).find((l) => l.source.endsWith("Scoreboard.java"));
    expect(link).toMatchObject({ method: "GET", routePath: "/league/clubs/{id}", target: "league/src/main/java/com/example/league/ClubController.java", confidence: "EXTRACTED" });
  });

  it("finds a Feign client's service by the name it registers under in discovery", () => {
    const feign = summary.apiCalls.find((c) => c.filePath.endsWith("ClubClient.java"));
    expect(feign?.origin).toMatchObject({ baseRef: { kind: "service", key: "league" }, host: "league", confidence: "EXTRACTED" });
    expect(feign?.origin?.project).toBe(summary.subProjects!.find((p) => p.root === "league")!.id);
    expect(feign?.origin?.evidence.find((e) => e.step === "address")?.detail).toMatch(/^league → .* \(name\)$/);
    // A name no project here registers under is a service elsewhere, never a third party.
    const other = summary.apiCalls.find((c) => c.filePath.endsWith("TransferClient.java"));
    expect(other?.origin).toMatchObject({ host: "transfers", confidence: "INFERRED" });
    expect(other?.origin?.external).toBeUndefined();
  });

  it("links WebClient, RestClient, HTTP-interface and Apache HttpClient calls through the league's address", () => {
    const links = (summary.apiRouteLinks ?? [])
      .filter((l) => /ClubCalls|KitClient/.test(l.source))
      .map((l) => `${l.source.split("/").pop()}:${l.sourceLine} ${l.method} ${l.routePath} ${l.confidence}`)
      .sort();
    expect(links).toEqual([
      "ClubCalls.java:10 POST /league/clubs/{id}/players EXTRACTED",
      "ClubCalls.java:11 DELETE /league/clubs/{id} EXTRACTED",
      "ClubCalls.java:9 GET /league/clubs/{id} EXTRACTED",
      "KitClient.java:6 PUT /league/clubs/{id}/kits EXTRACTED",
    ].sort());
    const origin = summary.apiCalls.find((c) => c.filePath.endsWith("ClubCalls.java") && c.line === 9)?.origin;
    expect(origin).toMatchObject({ host: "league", confidence: "EXTRACTED" });
  });
});
