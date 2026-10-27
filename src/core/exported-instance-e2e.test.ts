import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A module that exports an instance of its class under a name of the importer's
 * choosing (`export default new Players()`, `import PlayerAPI from './players'`):
 * `PlayerAPI.update(…)` is the class's inherited `update` (real-repo FP: a store
 * action one hop short of its request).
 */
describe("a call through an imported instance, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-instance-"));
    const root = join(dir, "web");
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "store"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "web", dependencies: { axios: "1.6.0" } }));
    await writeFile(join(root, "src", "api", "ApiClient.js"), [
      "class ApiClient {",
      "  constructor(resource) { this.resource = resource; }",
      "  get url() { return `/api/v2/${this.resource}`; }",
      "  update(id, data) { return axios.patch(`${this.url}/${id}`, data); }",
      "}",
      "export default ApiClient;",
    ].join("\n"));
    await writeFile(join(root, "src", "api", "players.js"), [
      "import ApiClient from './ApiClient';",
      "class Players extends ApiClient {",
      "  constructor() { super('players'); }",
      "  transfer(id) { return axios.post(`${this.url}/${id}/transfer`); }",
      "}",
      "export default new Players();",
    ].join("\n"));
    await writeFile(join(root, "src", "store", "players.js"), [
      "import PlayerAPI from '../api/players';",
      "export const actions = {",
      "  async update({ commit }, { id, ...data }) {",
      "    const response = await PlayerAPI.update(id, data);",
      "    commit('EDIT_PLAYER', response.data);",
      "  },",
      "};",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves the member on the exported instance's class and its base", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const link = summary.symbolLinks?.find((l) => l.sourceSymbol === "actions.update" && l.callName === "PlayerAPI.update");
    expect(link && [link.targetFile, link.targetSymbol, link.strategy]).toEqual(["src/api/ApiClient.js", "ApiClient.update", "inheritance"]);
  });
});
