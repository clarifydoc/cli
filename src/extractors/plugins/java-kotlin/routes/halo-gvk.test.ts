import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/** Real-repo FP: 11 extension kinds whose `@GVK` group is a sibling class's constant had no CRUD routes (66). */
const FILES: Record<string, string> = {
  "build.gradle": "plugins { id 'java' }\n",
  "src/main/java/com/example/league/content/Constant.java": `package com.example.league.content;

public enum Constant {
    ;

    public static final String GROUP = "content.league.example.com";
    public static final String VERSION = "v1alpha1";
}
`,
  "src/main/java/com/example/league/content/Club.java": `package com.example.league.content;

@GVK(group = Constant.GROUP, version = Constant.VERSION, kind = Club.KIND, plural = "clubs", singular = "club")
public class Club extends AbstractExtension {
    public static final String KIND = "Club";
}
`,
  "src/main/java/com/example/league/endpoint/ClubQueryEndpoint.java": `package com.example.league.endpoint;

import com.example.league.content.Club;

public class ClubQueryEndpoint implements CustomEndpoint {
    @Override
    public RouterFunction<ServerResponse> endpoint() {
        return SpringdocRouteBuilder.route()
            .GET("clubs", this::listClubs, builder -> builder.operationId("queryClubs"))
            .build();
    }

    @Override
    public GroupVersion groupVersion() {
        return PublicApiUtils.groupVersion(new Club());
    }
}
`,
  "src/main/java/com/example/league/endpoint/StandingsEndpoint.java": `package com.example.league.endpoint;

public class StandingsEndpoint implements CustomEndpoint {
    private static final String API_VERSION = "api.league.example.com/v1alpha1";

    @Override
    public RouterFunction<ServerResponse> endpoint() {
        return SpringdocRouteBuilder.route()
            .GET("standings", this::standings, builder -> builder.operationId("standings"))
            .build();
    }

    @Override
    public GroupVersion groupVersion() {
        return GroupVersion.parseAPIVersion(API_VERSION);
    }
}
`,
  // The same package in another module, beside a second class named `Constant`.
  "api/src/main/java/com/example/league/endpoint/Constant.java": `package com.example.league.endpoint;

public enum Constant {
    ;
    public static final String GROUP = "transfer.league.example.com";
    public static final String VERSION = "v1alpha2";
}
`,
  "src/main/java/com/example/league/endpoint/TransferEndpoint.java": `package com.example.league.endpoint;

public class TransferEndpoint implements CustomEndpoint {
    @Override
    public RouterFunction<ServerResponse> endpoint() {
        return SpringdocRouteBuilder.route()
            .POST("transfers", this::transfer, builder -> builder.operationId("transfer"))
            .build();
    }

    @Override
    public GroupVersion groupVersion() {
        return GroupVersion.parseAPIVersion("console.api." + Constant.GROUP + "/" + Constant.VERSION);
    }
}
`,
};

describe("@GVK CRUD routes whose group is another class's constant", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-halo-gvk-"));
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

  it("are served at the constants' values", () => {
    const routes = summary.routeMap.filter((r) => r.filePath?.endsWith("Club.java")).map((r) => `${r.httpMethod} ${r.path}`);
    expect(routes).toEqual([
      "GET /apis/content.league.example.com/v1alpha1/clubs",
      "POST /apis/content.league.example.com/v1alpha1/clubs",
      "GET /apis/content.league.example.com/v1alpha1/clubs/{name}",
      "PUT /apis/content.league.example.com/v1alpha1/clubs/{name}",
      "PATCH /apis/content.league.example.com/v1alpha1/clubs/{name}",
      "DELETE /apis/content.league.example.com/v1alpha1/clubs/{name}",
    ]);
  });

  it("serve a custom endpoint at the group version its groupVersion() computes", () => {
    const routes = summary.routeMap.filter((r) => r.filePath?.includes("/endpoint/")).map((r) => `${r.httpMethod} ${r.path}`).sort();
    expect(routes).toEqual([
      "GET /apis/api.content.league.example.com/v1alpha1/clubs",
      "GET /apis/api.league.example.com/v1alpha1/standings",
      "POST /apis/console.api.transfer.league.example.com/v1alpha2/transfers",
    ]);
  });
});
