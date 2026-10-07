import { describe, it, expect } from "vitest";
import "../../registry.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractHttpClientBases } from "./http-clients.js";

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

  it("records nothing for a base it cannot see", async () => {
    expect(await bases(`
const a = axios.create({ baseURL: process.env.API });
const b = axios.create({ baseURL: \`\${host}/api\` });
const c = axios.create(config);
`)).toEqual({});
  });
});
