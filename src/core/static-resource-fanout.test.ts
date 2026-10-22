import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Real-repo FP: a REST model base class builds every URL from the static
 * `getCollectionResource()` each subclass overrides, and the subclasses import
 * the base from the bundler's source root (`model/rest`). Every base-class call
 * took one subclass's URL, or none — 99 routes uncalled.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-ui", dependencies: { vue: "3.4.0" } }),
  "src/model/rest.js": `import $api from "common/api";

export class Rest {
  find(id, params) {
    return $api.get(this.getEntityResource(id), params).then((resp) => new this.constructor(resp.data));
  }
  save() {
    return $api.post(this.constructor.getCollectionResource(), this.getValues());
  }
  update() {
    return $api.put(this.getEntityResource(), this.getValues());
  }
  getEntityResource(id) {
    if (!id) {
      id = this.getId();
    }
    return this.constructor.getCollectionResource() + "/" + id;
  }
  static getCollectionResource() {
    throw new Error("not implemented");
  }
  static search(params) {
    return $api.get(this.getCollectionResource(), { params });
  }
}

export default Rest;
`,
  // A middle class importing the base under another name, as its default export.
  "src/model/collection.js": `import RestModel from "model/rest";

export class Collection extends RestModel {
  getCover() {
    return this.Cover;
  }
}

export default Collection;
`,
  "src/model/club.js": `import Collection from "model/collection";

export class Club extends Collection {
  static getCollectionResource() {
    return "clubs";
  }
}
`,
  "src/model/player.js": `import { Rest } from "model/rest";

export class Player extends Rest {
  static getCollectionResource() {
    return "players";
  }
}
`,
  "server/routes.go": `package server

func Register(router *gin.RouterGroup) {
	router.GET("/clubs/:uid", GetClub)
	router.POST("/clubs", CreateClub)
	router.PUT("/clubs/:uid", UpdateClub)
	router.GET("/clubs", SearchClubs)
	router.GET("/players/:uid", GetPlayer)
	router.PUT("/players/:uid", UpdatePlayer)
}
`,
};

describe("a base class's calls through a static resource each subclass overrides", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-static-resource-"));
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

  it("request each subclass's own URL, and link to its routes", () => {
    const calls = summary.apiCalls.filter((c) => c.filePath === "src/model/rest.js").map((c) => `${c.line} ${c.name} ${c.target} ${c.viaSubclass}`).sort();
    expect(calls).toEqual([
      "11 put /clubs/{} Club",
      "11 put /players/{} Player",
      "23 get /clubs Club",
      "23 get /players Player",
      "5 get /clubs/{} Club",
      "5 get /players/{} Player",
      "8 post /clubs Club",
      "8 post /players Player",
    ]);
    expect((summary.apiRouteLinks ?? []).map((l) => `${l.sourceLine} ${l.method} ${l.routePath}`).sort()).toEqual([
      "11 PUT /clubs/:uid",
      "11 PUT /players/:uid",
      "23 GET /clubs",
      "5 GET /clubs/:uid",
      "5 GET /players/:uid",
      "8 POST /clubs",
    ]);
  });
});
