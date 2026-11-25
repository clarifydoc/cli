import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";

/**
 * A handler factory builds its request options in a local and hands them to a project request wrapper
 * (real-repo FP): `const ajaxOptions = { url: `${requestUrl}?…`, method: id ? 'PUT' : 'POST', … };
 * createAjaxRequest(ajaxOptions)`, with `const requestUrl = id ? `${url}/${id}` : url`. Each arm is a request,
 * its verb paired with its URL. Decoys: a spread in the options, a test that differs between the verb and the URL.
 */
async function apiCalls(src: string): Promise<string[]> {
  const tree = await parseSource(src, "javascript" as any, "x.js");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call").map((d) => `${d.name} ${d.target}`);
}

describe("request options held in a local", () => {
  it("reads a named options object handed to a request wrapper, one request per arm of a shared condition", async () => {
    const rows = await apiCalls(`import createAjaxRequest from 'Utilities/createAjaxRequest';
function createSaveGarageHandler(section, url) {
  return function(getState, payload) {
    const { id, ...rest } = payload;
    const requestUrl = id ? \`\${url}/\${id}\` : url;
    const ajaxOptions = { url: \`\${requestUrl}?\${$.param(rest, true)}\`, method: id ? 'PUT' : 'POST', dataType: 'json', data: JSON.stringify(rest) };
    const { request } = createAjaxRequest(ajaxOptions);
    return request;
  };
}`);
    expect(rows.map((r) => r.replace(/\?.*$/, ""))).toEqual(["put ${url}/${id}", "post ${url}"]);
  });

  it("reads a named options object with one verb like the same object written in place", async () => {
    const rows = await apiCalls(`function removeCar(url, id) {
  const ajaxOptions = { url: \`\${url}/\${id}\`, dataType: 'json' };
  return createAjaxRequest(ajaxOptions);
}`);
    expect(rows).toEqual(["request ${url}/${id}"]);
  });

  it("reads nothing from a record held in a local and handed to a call not named for a request (real-repo FP)", async () => {
    expect(await apiCalls(`export async function createMatch(api, url, body) {
  const form = { name: "derby", url, body };
  return api.createMatch(form);
}`)).toEqual([]);
  });

  it("reads nothing from options with a spread, and no pairing when the verb's test is another", async () => {
    expect(await apiCalls(`function scrap(base, url, id) {
  const ajaxOptions = { ...base, url: \`\${url}/\${id}\`, dataType: 'json' };
  return createAjaxRequest(ajaxOptions);
}`)).toEqual([]);
    const rows = await apiCalls(`function save(url, id, isNew) {
  const requestUrl = id ? \`\${url}/\${id}\` : url;
  return createAjaxRequest({ url: requestUrl, method: isNew ? 'POST' : 'PUT', dataType: 'json' });
}`);
    expect(rows.filter((r) => /^(put|post) /.test(r))).toEqual([]);
  });
});
