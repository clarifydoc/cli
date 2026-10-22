import { describe, it, expect } from "vitest";
import "../../registry.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractHttpClientBases, extractHttpClientRegistrations } from "./http-clients.js";
import { jsBaseRefOf } from "./service-config.js";

async function bases(src: string) {
  await ensureLanguagesLoaded(["typescript"]);
  return extractHttpClientBases(await parseSource(src, "typescript", "c.ts"), src);
}

describe("extractHttpClientBases", () => {
  it("reads stated base URLs, including an env variable's literal fallback", async () => {
    expect(await bases(`
const apiClient = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api', timeout: 1 });
const v1 = ky.create({ prefixUrl: "https://host.example/v1/" });
const root = axios.create({ baseURL: \`/\` });
`)).toEqual({ apiClient: "/api", v1: "/v1", root: "" });
  });

  it("reads a generated SDK client's base (hey-api `createClient(createConfig({ baseUrl }))`, openapi-fetch)", async () => {
    expect(await bases(`
export const client: Client = createClient(createConfig<ClientOptions2>({ baseUrl: '/api/v2', throwOnError: true }));
const fetcher = createClient<paths>({ baseUrl: "https://api.example.com/v1" });
const redis = createClient({ url: "redis://localhost" });
`)).toEqual({ client: "/api/v2", fetcher: "/v1" });
  });

  it("records nothing for a base it cannot see", async () => {
    expect(await bases(`
const a = axios.create({ baseURL: process.env.API });
const b = axios.create({ baseURL: \`\${host}/api\` });
const c = axios.create(config);
`)).toEqual({});
  });
});

describe("extractHttpClientRegistrations", () => {
  it("keeps the host of a literal base and the variable an env base reads", async () => {
    await ensureLanguagesLoaded(["typescript"]);
    const src = `
const fleet = axios.create({ baseURL: process.env.FLEET_URL });
const cars = axios.create({ baseURL: process.env.CARS_URL ?? "http://localhost:5101" });
const partner = ky.create({ prefixUrl: "https://api.partner.com/v1" });
const local = axios.create({ baseURL: "/api" });
`;
    const regs = extractHttpClientRegistrations(await parseSource(src, "typescript", "c.ts"), src);
    expect(regs.map(({ line: _l, ...r }) => r)).toEqual([
      { client: "fleet", scope: "file", base: { kind: "env", key: "FLEET_URL" } },
      { client: "cars", scope: "file", base: { kind: "env", key: "CARS_URL", fallback: "http://localhost:5101" } },
      { client: "partner", scope: "file", base: { kind: "literal", key: "https://api.partner.com/v1" } },
    ]);
  });

  it("reads a base a constant of the file holds (real-repo FP)", async () => {
    await ensureLanguagesLoaded(["typescript"]);
    const src = `
const BADGES_BASE_URL = "https://badges.example.com";
export const badges = axios.create({ baseURL: BADGES_BASE_URL });
`;
    const regs = extractHttpClientRegistrations(await parseSource(src, "typescript", "c.ts"), src);
    expect(regs.map(({ line: _l, ...r }) => r)).toEqual([
      { client: "badges", scope: "file", base: { kind: "literal", key: "https://badges.example.com" } },
    ]);
  });
});

describe("jsBaseRefOf", () => {
  it("reads environment variables however the runtime exposes them", () => {
    for (const expr of ["process.env.CARS_URL", "process.env['CARS_URL']", "import.meta.env.CARS_URL", "Bun.env.CARS_URL", 'Deno.env.get("CARS_URL")']) {
      expect(jsBaseRefOf(expr), expr).toEqual({ kind: "env", key: "CARS_URL" });
    }
    expect(jsBaseRefOf("process.env.API || 'http://localhost:3000'")).toEqual({ kind: "env", key: "API", fallback: "http://localhost:3000" });
  });

  it("reads nothing into a value it cannot see", () => {
    expect(jsBaseRefOf("this.baseUrl")).toBeNull();
    expect(jsBaseRefOf("environment.apiUrl")).toBeNull();
    expect(jsBaseRefOf("'/api'")).toBeNull();
  });
});
