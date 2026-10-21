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
