import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";

/**
 * API clients and services written as namespace objects — realworld's
 * `agent.js` is `const Profile = { get: username => requests.get(…) }`,
 * exported in a default object and called as `agent.Profile.get(…)`. Their
 * members used to be no symbol at all: the call linked to nothing, and the
 * api-call inside had no enclosing function to belong to.
 */
async function fns(src: string) {
  const tree = await parseSource(src, "typescript" as any, "agent.ts");
  return new JavaScriptExtractor().extractFunctions(tree, src);
}
const names = async (src: string) => (await fns(src)).map((f) => f.name).filter((n) => n !== "<setup>");

describe("namespace objects", () => {
  it("names a module-level object's function members prefix.key, with their params and calls", async () => {
    const out = await fns(`
const requests = {
  get: url => superagent.get(API_ROOT + url).then(responseBody),
  put: (url, body) => superagent.put(API_ROOT + url, body),
};
export const Profile = {
  follow(username) { return requests.post(\`/profiles/\${username}/follow\`); },
  get: username =>
    requests.get(\`/profiles/\${username}\`),
};`);
    const get = out.find((f) => f.name === "Profile.get")!;
    expect(get.params.map((p) => p.name)).toEqual(["username"]); // bare `u =>` has its param
    expect(get.calls.map((c) => c.name)).toEqual(["requests.get"]);
    expect([get.line, get.endLine]).toEqual([8, 9]);
    expect(get.isExported).toBe(true);
    expect(out.find((f) => f.name === "requests.put")!.params.map((p) => p.name)).toEqual(["url", "body"]);
    expect(out.find((f) => f.name === "Profile.follow")!.calls.map((c) => c.name)).toEqual(["requests.post"]);
  });

  it("nests prefixes, and names default-export and module.exports members by key", async () => {
    expect(await names(`const api = { users: { get: (id) => http.get(id) } };`)).toEqual(["api.users.get"]);
    expect(await names(`export default { Articles, Profile, setToken: _token => { token = _token; } };`)).toEqual(["setToken"]);
    expect(await names(`module.exports = { hash: (s) => crypto(s), check(a, b) { return a === b; } };`)).toEqual(["hash", "check"]);
  });

  it("leaves values, objects inside functions, and Vue options objects alone", async () => {
    // Data, not a namespace.
    expect(await names(`const config = { retries: 3, base: "/api" };`)).toEqual([]);
    // Built inside a function: a value that function passes around, and its
    // arrows' calls already belong to the enclosing function.
    expect(await names(`function setup() { const handlers = { onSave: () => save() }; return handlers; }`)).toEqual(["setup"]);
    // A Vue Options API component: `methods` are flattened onto `this`, so
    // `save` is a function of its own name (not `methods.save`), as is `data`.
    expect(await names(`export default { data() { return {}; }, methods: { save() { api.post(); } } };`)).toEqual(["data", "save"]);
  });
});
