import { describe, it, expect } from "vitest";
import { ensureLanguagesLoaded } from "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractDevProxyRules } from "./dev-proxies.js";
import { jsServiceConfig } from "./service-config.js";

async function rules(src: string, file: string) {
  await ensureLanguagesLoaded(["typescript"]);
  return extractDevProxyRules(await parseSource(src, "typescript", file), src, file).map(({ line: _l, file: _f, ...r }) => r);
}

describe("extractDevProxyRules", () => {
  it("reads Vite's proxy map: a bare target, an options object, a rewrite", async () => {
    expect(await rules(`
export default defineConfig({ server: { proxy: {
  "/api": { target: process.env.API ?? "http://localhost:5000", changeOrigin: true, rewrite: (p) => p.replace(/^\\/api/, "") },
  "/auth": "http://localhost:5001",
  "^/files/.*": "http://localhost:5002",
  "/socket": { target: "ws://localhost:5003", ws: true },
} } });`, "web/vite.config.ts")).toEqual([
      { pathPrefix: "/api", target: "http://localhost:5000", rewriteTo: "", via: "vite" },
      { pathPrefix: "/auth", target: "http://localhost:5001", via: "vite" },
      { pathPrefix: "/files", target: "http://localhost:5002", via: "vite" },
    ]);
  });

  it("reads webpack devServer arrays and http-proxy-middleware in setupProxy", async () => {
    expect(await rules(`module.exports = { devServer: { proxy: [{ context: ["/api", "/auth"], target: "http://localhost:4000", pathRewrite: { "^/api": "/v1" } }] } };`, "webpack.config.js")).toEqual([
      { pathPrefix: "/api", target: "http://localhost:4000", rewriteTo: "/v1", via: "webpack" },
      { pathPrefix: "/auth", target: "http://localhost:4000", via: "webpack" },
    ]);
    expect(await rules(`module.exports = (app) => { app.use("/api", createProxyMiddleware({ target: "http://localhost:4000", changeOrigin: true })); };`, "src/setupProxy.js")).toEqual([
      { pathPrefix: "/api", target: "http://localhost:4000", via: "cra" },
    ]);
  });

  it("reads a proxy whose options a local helper returns (real-repo FP)", async () => {
    expect(await rules(`
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  function serviceProxy(service: string, port: number, target = env.VITE_PROXY_TARGET): ProxyOptions {
    return { target: target || \`http://localhost:\${port}\`, changeOrigin: true, rewrite: target ? (path) => \`/\${service}\${path}\` : undefined };
  }
  return { server: { proxy: {
    "/club-service/": serviceProxy("club-service", 8083),
    "/league/service/": serviceProxy("league", 8079, env.VITE_LEAGUE_TARGET),
  } } };
});`, "web/vite.config.mts")).toEqual([
      { pathPrefix: "/club-service", target: "http://localhost:8083", via: "vite" },
      { pathPrefix: "/league/service", target: "http://localhost:8079", via: "vite" },
    ]);
  });

  it("reads only config files", async () => {
    expect(await rules(`const x = { proxy: { "/api": "http://localhost:5000" } };`, "src/settings.ts")).toEqual([]);
  });
});

describe("JS proxy files", () => {
  const [angular, cra] = jsServiceConfig.proxySources!;
  it("reads Angular's proxy.conf.json and CRA's package.json proxy", () => {
    expect(angular!.parse(`{ "/api/*": { "target": "http://localhost:5000", "secure": false, "pathRewrite": { "^/api": "" } } }`, "proxy.conf.json").map(({ line: _l, ...r }) => r))
      .toEqual([{ pathPrefix: "/api", target: "http://localhost:5000", rewriteTo: "", via: "angular" }]);
    expect(cra!.parse(`{ "name": "web", "proxy": "http://localhost:4000" }`, "package.json").map(({ line: _l, ...r }) => r))
      .toEqual([{ pathPrefix: "", target: "http://localhost:4000", via: "cra" }]);
    expect(cra!.parse(`{ "name": "web" }`, "package.json")).toEqual([]);
  });
});

describe("nginx forwarding rules", () => {
  const nginx = jsServiceConfig.proxySources!.find((s) => s.files.includes("**/nginx.conf"))!;

  it("reads prefix locations, upstreams, URI rewrites and envsubst templates; skips regex and $variable targets", () => {
    const conf = `upstream backend { server cars-api:8080 max_fails=3; }
server {
  listen 80;
  location / { try_files $uri $uri/ /index.html; }
  location /api/hub {
    proxy_pass http://\${API_SERVICE_NAME};   # websockets
    proxy_http_version 1.1;
  }
  location /api/ { proxy_pass http://\${API_SERVICE_NAME}; }
  location ^~ /cars/ { proxy_pass http://backend/api/v1/; }
  location ~ \\.php$ { proxy_pass http://php; }
  location /dyn/ { proxy_pass http://$host_from_map; }
}`;
    expect(nginx.parse(conf, "default.conf.template").map(({ line: _l, ...r }) => r)).toEqual([
      { pathPrefix: "/api/hub", target: "http://${API_SERVICE_NAME}", via: "nginx" },
      { pathPrefix: "/api", target: "http://${API_SERVICE_NAME}", via: "nginx" },
      { pathPrefix: "/cars", target: "http://cars-api:8080", rewriteTo: "/api/v1", via: "nginx" },
    ]);
    expect(nginx.parse(conf, "default.conf.template")[1]!.line).toBe(9);
  });
});
