import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A composable's local read by the functions it returns:
 * `const api = useLeagueApi()` in `useClubs`, `api.clubs.fetchClub(id)` in its `getOne`.
 */
describe("a local of the enclosing function, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-closure-"));
    const root = join(dir, "web");
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "composables", "api"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "web", dependencies: { vue: "3.4.0", axios: "1.6.0" } }));
    await writeFile(join(root, "src", "api", "clubs.ts"), [
      'import axios from "axios";',
      "export class ClubsApi {",
      "  async fetchClub(id: string) { return axios.get(`/api/clubs/${id}`); }",
      "}",
      "export class LeagueApi {",
      "  public clubs: ClubsApi;",
      "  constructor() { this.clubs = new ClubsApi(); }",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src", "composables", "api", "index.ts"), 'export { useLeagueApi } from "./api-client";\n');
    await writeFile(join(root, "src", "composables", "api", "api-client.ts"), [
      'import { LeagueApi } from "../../api/clubs";',
      "export const useLeagueApi = function (): LeagueApi {",
      "  return new LeagueApi();",
      "};",
    ].join("\n"));
    await writeFile(join(root, "src", "composables", "use-clubs.ts"), [
      'import { useLeagueApi } from "./api";',
      "export function useClubs() {",
      "  const api = useLeagueApi();",
      "  async function getOne(id: string) {",
      "    return await api.clubs.fetchClub(id);",
      "  }",
      "  return { getOne };",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types the call through the enclosing function's local, not the factory that built it", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const link = summary.symbolLinks?.find((l) => l.sourceSymbol === "getOne" && l.callName === "api.clubs.fetchClub");
    expect(link && [link.targetFile, link.targetSymbol]).toEqual(["src/api/clubs.ts", "ClubsApi.fetchClub"]);
  });
});
