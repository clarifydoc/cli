import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractModuleValues } from "./module-values.js";

async function valuesOf(src: string) {
  const tree = await parseSource(src, "typescript" as never, "x.ts");
  return extractModuleValues(tree, src);
}

describe("extractModuleValues", () => {
  it("folds module constants into an exported object's members (Kavita environment.ts)", async () => {
    expect(
      await valuesOf(`
const IP = 'localhost';
export const environment = {
  production: false,
  apiUrl: 'http://' + IP + ':5000/api/',
  buyLink: 'https://buy.stripe.com/test',
};`),
    ).toEqual({
      "environment.apiUrl": "http://localhost:5000/api/",
      "environment.buyLink": "https://buy.stripe.com/test",
    });
  });

  it("follows a shorthand member to its constant (mealie config.ts)", async () => {
    expect(await valuesOf(`const PREFIX = "/api";\nexport const config = { PREFIX };`)).toEqual({
      PREFIX: "/api",
      "config.PREFIX": "/api",
    });
  });

  it("keeps an unknown piece as a hole and skips values that are no URL", async () => {
    expect(await valuesOf(`export const API = import.meta.env.VITE_API + '/v1';\nexport const TITLE = 'Shop';`)).toEqual({
      API: "${import.meta.env.VITE_API}/v1",
    });
  });

  it("keeps an API version a URL splices in (chatwoot DEFAULT_API_VERSION)", async () => {
    expect(await valuesOf(`const DEFAULT_API_VERSION = 'v1';\nconst API = '/api/';`)).toEqual({
      DEFAULT_API_VERSION: "v1",
      API: "/api/",
    });
  });
});
