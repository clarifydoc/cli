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
