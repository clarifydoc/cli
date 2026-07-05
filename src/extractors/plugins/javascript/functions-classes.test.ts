import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";

/**
 * URL-builder template extraction. A frontend helper that returns an
 * app-relative request URL (`requestUri(endpoint, version)`) is captured as a
 * parameterized template — params as `{name}`, env base dropped, other runtime
 * refs as `{}` — so a project-level pass can substitute call-site args.
 */
async function templateOf(src: string, fnName: string): Promise<string | undefined> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  const fns = new JavaScriptExtractor().extractFunctions(tree, src);
  return fns.find((f) => f.name === fnName)?.urlTemplate;
}

describe("URL-builder template extraction", () => {
  it("builds a template from a concat chain, dropping env base and runtime vars", async () => {
    const SRC = `export function requestUri(endpoint: string, version = 'v2'): string {
      const id = useStore().selectedInstitutionId;
      return import.meta.env.VITE_API + '/api/' + version + '/institution/' + id + '/' + endpoint;
    }`;
    expect(await templateOf(SRC, "requestUri")).toBe("/api/{version}/institution/{}/{endpoint}");
  });

  it("follows a one-hop local const and a template literal return", async () => {
    const SRC = `export function adminUri(aSubPath: string, version = 'v1'): string {
      const str = import.meta.env.VITE_ADMIN + \`/api/\${version}/\${aSubPath}\`;
      return str;
    }`;
    expect(await templateOf(SRC, "adminUri")).toBe("/api/{version}/{aSubPath}");
  });

  it("handles an expression-bodied arrow", async () => {
    const SRC = `export const uri = (sub: string) => '/api/' + sub;`;
    expect(await templateOf(SRC, "uri")).toBe("/api/{sub}");
  });

  it("does not set a template for a non-URL function (no slash)", async () => {
    const SRC = `export function label(name: string) { return 'prefix-' + name; }`;
    expect(await templateOf(SRC, "label")).toBeUndefined();
  });
});
