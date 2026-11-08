import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * (real-repo FP) A generic REST base whose subclasses override some of its methods and
 * call `super.x(...)`, and an API client whose subclass states its URL in a getter.
 */
const FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "web", dependencies: { "@angular/core": "17.0.0", axios: "1.0.0" } }),
  "web/src/base.service.ts": `import { HttpClient } from '@angular/common/http'
export abstract class AbstractClubService<T> {
  protected http: HttpClient
  protected resourceName: string
  constructor() {}
  protected getResourceUrl(id?: number): string {
    let url = \`/api/\${this.resourceName}/\`
    if (id !== undefined) url += \`\${id}/\`
    return url
  }
  list() { return this.http.get<T[]>(this.getResourceUrl()) }
  create(o: T) { return this.http.post<T>(this.getResourceUrl(), o) }
  update(o: T) { return this.http.put<T>(this.getResourceUrl(1), o) }
  delete(o: T) { return this.http.delete(this.getResourceUrl(1)) }
}
`,
  "web/src/lineup.service.ts": `import { AbstractClubService } from './base.service'
import { tap } from 'rxjs'
export class LineupService extends AbstractClubService<any> {
  constructor() { super(); this.resourceName = 'lineups' }
  create(o: any) { return super.create(o).pipe(tap(() => this.reload())) }
  delete(o: any) { return super.delete(o).pipe(tap(() => this.reload())) }
  reload() {}
}
`,
  "web/src/match.service.ts": `import { AbstractClubService } from './base.service'
export class MatchService extends AbstractClubService<any> {
  constructor() { super(); this.resourceName = 'matches' }
}
`,
  "web/src/league.service.ts": `import { AbstractClubService } from './base.service'
export class LeagueService extends AbstractClubService<any> {
  constructor() { super(); this.resourceName = 'leagues' }
  create(o: any) { return this.http.post('/custom/leagues', o) }
}
`,
  "web/src/comp.ts": `import { LineupService } from './lineup.service'
export class ViewsComponent {
  constructor(private svc: LineupService) {}
  remove(v: any) { this.svc.delete(v).subscribe() }
  add(v: any) { this.svc.create(v).subscribe() }
}
`,
  "web/src/client.js": `import axios from 'axios'
const DEFAULT_API_VERSION = 'v1'
export class ApiClient {
  constructor(resource, options = {}) {
    this.apiVersion = \`/api/\${options.apiVersion || DEFAULT_API_VERSION}\`
    this.options = options
    this.resource = resource
  }
  get url() { return \`\${this.baseUrl()}/\${this.resource}\` }
  baseUrl() {
    let url = this.apiVersion
    if (this.options.academy) { url = \`/academy\${url}\` }
    return url
  }
  get() { return axios.get(this.url) }
  show(id) { return axios.get(\`\${this.url}/\${id}\`) }
  create(data) { return axios.post(this.url, data) }
  update(id, data) { return axios.patch(\`\${this.url}/\${id}\`, data) }
  delete(id) { return axios.delete(\`\${this.url}/\${id}\`) }
}
`,
  "web/src/notes.js": `import { ApiClient } from './client'
class ClubNotes extends ApiClient {
  constructor() { super('notes'); this.clubId = null }
  get url() { return \`\${this.baseUrl()}/clubs/\${this.clubId}/notes\` }
  get(clubId) { this.clubId = clubId; return super.get() }
  create(clubId, content) { this.clubId = clubId; return super.create({ content }) }
  delete(clubId, id) { this.clubId = clubId; return super.delete(id) }
}
export default new ClubNotes()
`,
  "web/src/players.js": `import { ApiClient } from './client'
class Players extends ApiClient { constructor() { super('players') } }
export default new Players()
`,
  "web/src/notes-view.js": `import notes from './notes'
export function load(id) { return notes.get(id) }
export function add(id, c) { return notes.create(id, c) }
export function remove(id, n) { return notes.delete(id, n) }
`,
  "api/routes.py": `from fastapi import APIRouter
router = APIRouter()
@router.post("/api/lineups/")
def c(): pass
@router.delete("/api/lineups/{id}/")
def d(id): pass
@router.get("/api/lineups/")
def l(): pass
@router.get("/api/v1/clubs/{id}/notes")
def ng(id): pass
@router.post("/api/v1/clubs/{id}/notes")
def nc(id): pass
@router.delete("/api/v1/clubs/{id}/notes/{nid}")
def nd(id, nid): pass
@router.get("/api/v1/notes/{id}")
def wrongget(id): pass
@router.patch("/api/v1/notes/{id}")
def wrongpatch(id): pass
@router.get("/api/v1/players")
def pl(): pass
@router.post("/api/matches/")
def mc(): pass
`,
};

describe("a REST base class and the subclasses that override its methods", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-crud-base-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = () => summary.apiCalls.filter((c) => /^web\/src\//.test(c.filePath)).map((c) => `${c.filePath.split("/").pop()}:${c.line} ${c.name} ${c.target} ${c.viaSubclass ?? ""}`).sort();

  const links = () => summary.apiRouteLinks ?? [];
  const reached = (file: string, line: number, via: string) =>
    links().filter((l) => l.source === file && l.sourceLine === line && l.viaSubclasses?.includes(via)).map((l) => `${l.method} ${l.routePath}`);

  it("keeps the inherited request of a method an override reaches with super.<name>(...)", () => {
    const r = rows();
    expect(r).toContain("base.service.ts:12 post /api/lineups/ LineupService");
    expect(r).toContain("base.service.ts:14 delete /api/lineups/{}/ LineupService");
    // the decoy subclass keeps its own URL, not the other's
    expect(r).toContain("base.service.ts:12 post /api/matches/ MatchService");
    expect(r.filter((x) => x.includes("lineups") && x.includes("MatchService"))).toEqual([]);
    // an override that does not call super replaces the inherited request
    expect(r.filter((x) => x.endsWith(" LeagueService")).map((x) => x.split(" ")[0])).not.toContain("base.service.ts:12");
    expect(r).toContain("base.service.ts:11 get /api/leagues/ LeagueService");
  });

  it("links super.create / super.delete in an override to the inherited member", () => {
    const l = summary.symbolLinks.filter((x) => x.callName.startsWith("super.") && x.strategy === "inheritance").map((x) => `${x.sourceSymbol} -> ${x.targetSymbol}`);
    expect(l).toContain("LineupService.create -> AbstractClubService.create");
    expect(l).toContain("LineupService.delete -> AbstractClubService.delete");
    expect(l).toContain("ClubNotes.create -> ApiClient.create");
    expect(l).toContain("ClubNotes.delete -> ApiClient.delete");
  });

  it("reads a URL getter the subclass overrides from the subclass", () => {
    const r = rows();
    expect(r.some((x) => /^client\.js:\d+ \w+ \/api\/v1\/clubs\/.*\/notes.* ClubNotes$/.test(x))).toBe(true);
    expect(r).toContain("client.js:17 post /api/v1/players Players");
    // never the base class's own getter value for a subclass that overrides it
    expect(r.filter((x) => x.endsWith(" ClubNotes") && x.includes("/api/v1/notes"))).toEqual([]);
  });

  it("reaches the routes: notes through its own getter, and not the namesake path", () => {
    const hit = (line: number, via: string) => reached("web/src/client.js", line, via);
    expect(hit(17, "ClubNotes")).toEqual(["POST /api/v1/clubs/{id}/notes"]);
    expect(hit(19, "ClubNotes")).toEqual(["DELETE /api/v1/clubs/{id}/notes/{nid}"]);
    expect(hit(17, "Players")).toEqual([]);
    // the trace starts at the subclass's override, which reaches the handler through the inherited request
    const http = summary.symbolLinks.filter((x) => x.relation === "http").map((x) => `${x.sourceSymbol} -> ${x.targetSymbol}`);
    expect(http).toContain("LineupService.delete -> d");
    expect(http).toContain("LineupService.create -> c");
    expect(http).toContain("MatchService.create -> mc");
  });
});
