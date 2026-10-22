import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import "../extractors/registry.js";
import { readProjectProxies } from "./config-values.js";
import type { SubProject } from "../types/analysis.js";

describe("readProjectProxies", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-proxies-"));
    await mkdir(join(dir, "web"), { recursive: true });
    await writeFile(join(dir, "web", "default.conf.template"), `server {
  location /api/ { proxy_pass http://\${API_SERVICE_NAME}; }
  location /files/ { proxy_pass http://\${FILES_HOST}; }
}`);
    await writeFile(join(dir, "web", "Dockerfile"), `FROM nginx:1.27
ENV API_SERVICE_NAME "cars-api"
COPY default.conf.template /etc/nginx/templates/`);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fills an envsubst target from the ENV of the image's Dockerfile and drops what stays a template", async () => {
    const web = { id: "web", root: "web" } as unknown as SubProject;
    const rules = (await readProjectProxies(dir, [web])).get("web") ?? [];
    expect(rules.map(({ line: _l, ...r }) => r)).toEqual([
      { pathPrefix: "/api", target: "http://cars-api", via: "nginx", file: "web/default.conf.template" },
    ]);
  });
});

describe("readProjectConfig — Spring Boot", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-spring-config-"));
    await mkdir(join(dir, "league", "src", "main", "resources"), { recursive: true });
    await mkdir(join(dir, "league", "src", "main", "docker"), { recursive: true });
    await writeFile(join(dir, "league", "src", "main", "resources", "application.yml"), `server:
  port: 8080
clubs:
  service:
    url: \${CLUBS_URL:http://clubs:8080/api}
spring:
  rabbitmq:
    host: broker
---
spring:
  config:
    activate:
      on-profile: test
clubs:
  service:
    url: http://localhost:9999
`);
    await writeFile(join(dir, "league", "src", "main", "resources", "application-prod.properties"), "fixtures.base-url=https://fixtures.example.com/v2\nsecret.token=abc\n");
    await writeFile(join(dir, "league", "src", "main", "docker", "application.yaml"), "stats:\n  url: http://stats:8081\n");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads application.yml documents, profiles and properties, a placeholder's default as the value", async () => {
    const { readProjectConfig } = await import("./config-values.js");
    const { manifestFor } = await import("../extractors/registry.js");
    const league = { id: "league", root: "league" } as unknown as SubProject;
    const values = (await readProjectConfig(dir, [league], manifestFor("java")!.serviceConfig!.sources!)).get("league") ?? [];
    expect(values.map((v) => `${v.key}=${v.value}${v.profile ? ` [${v.profile}${v.test ? ", test" : ""}]` : ""}`).sort()).toEqual([
      "clubs.service.url=http://clubs:8080/api",
      "clubs.service.url=http://localhost:9999 [test, test]",
      "fixtures.base-url=https://fixtures.example.com/v2 [prod]",
      "stats.url=http://stats:8081",
    ]);
  });
});
