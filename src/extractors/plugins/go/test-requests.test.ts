import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import "../../registry.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { fileTestVerdict } from "../../../core/test-functions.js";
import type { FileAnalysis, ProjectAnalysis } from "../../../types/analysis.js";
import { extractGoDataSources } from "./data-sources.js";
import { goRequestFactoryRows } from "./path-arg-calls.js";

const HELPERS = `package webtests

import (
\t"net/http"
\t"net/http/httptest"
\t"strings"
\t"testing"
)

const standingsPath = "/api/v2/standings"

func leagueRequest(t *testing.T, e http.Handler, method, path, body string) *httptest.ResponseRecorder {
\tt.Helper()
\treq := httptest.NewRequest(method, path, strings.NewReader(body))
\trec := httptest.NewRecorder()
\te.ServeHTTP(rec, req)
\treturn rec
}

func clubRequest(t *testing.T, e http.Handler, club string) *httptest.ResponseRecorder {
\tt.Helper()
\treq := httptest.NewRequest(http.MethodGet, "/api/v2/clubs/"+club+"/squad", nil)
\trec := httptest.NewRecorder()
\te.ServeHTTP(rec, req)
\treturn rec
}

func standingsRequest(e http.Handler) {
\treq := httptest.NewRequest("GET", standingsPath, nil)
\te.ServeHTTP(httptest.NewRecorder(), req)
}

func handlerContext(method string) {
\treq := httptest.NewRequest(method, "/", nil)
\t_ = req
}

func tokenAllows(e *echo.Echo, token string) bool {
\treq := httptest.NewRequest(http.MethodGet, "/api/v2/fixtures", nil)
\tc := e.NewContext(req, httptest.NewRecorder())
\treturn CanRequest(c, token)
}

func externalFetch(t *testing.T, method, url string) {
\treq, _ := http.NewRequest(method, url, nil)
\t_ = req
}
`;

describe("Go in-process test requests", () => {
  it("reads a test's in-process request at its method and path, a helper's path parameter as a factory", () => {
    const lines = HELPERS.split("\n");
    expect(extractGoDataSources(lines).filter((d) => d.kind === "api-call").map((d) => `${d.name} ${d.target} @${d.line}`)).toEqual([
      "GET /api/v2/clubs/${club}/squad @22",
      "GET /api/v2/standings @29",
      "httptest.NewRequest ${path} @14",
    ]);
    // A request handed to a context, not the router, runs no route; a test helper's request of an
    // outside URL is no request of the app.
    expect(goRequestFactoryRows(lines).map((d) => `${d.name} ${d.target}`)).toEqual(["httptest.NewRequest ${path}"]);
  });
});

/** A test requesting the router reaches the handler of the route it requests (real-repo shape). */
const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.22\n\nrequire github.com/labstack/echo/v4 v4.11.0\n",
  "pkg/routes/routes.go": `package routes

import (
\t"github.com/labstack/echo/v4"

\t"example.com/league/pkg/clubs"
)

func RegisterRoutes(e *echo.Echo) {
\te.POST("/api/v2/clubs/:club/transfers", clubs.Transfer)
\te.GET("/api/v2/clubs/:club/scouting", clubs.Scouting)
\te.GET("/api/v2/clubs/:club/squad", clubs.Squad)
}
`,
  "pkg/clubs/handlers.go": `package clubs

import (
\t"github.com/labstack/echo/v4"

\t"example.com/league/pkg/ledger"
)

func Transfer(c echo.Context) error {
\tledger.RecordTransfer(c.Param("club"))
\treturn nil
}

func Scouting(c echo.Context) error {
\tledger.RecordScouting(c.Param("club"))
\treturn nil
}

func Squad(c echo.Context) error {
\tledger.ListSquad(c.Param("club"))
\treturn nil
}
`,
  "pkg/ledger/transfers.go": `package ledger

func RecordTransfer(club string) string {
\treturn club
}
`,
  "pkg/ledger/scouting.go": `package ledger

func RecordScouting(club string) string {
\treturn club
}
`,
  "pkg/ledger/squad.go": `package ledger

func ListSquad(club string) string {
\treturn club
}
`,
  "pkg/webtests/helpers_test.go": `package webtests

import (
\t"net/http/httptest"
\t"strings"
\t"testing"

\t"github.com/labstack/echo/v4"
)

func leagueRequest(t *testing.T, e *echo.Echo, method, path, body string) *httptest.ResponseRecorder {
\tt.Helper()
\treq := httptest.NewRequest(method, path, strings.NewReader(body))
\trec := httptest.NewRecorder()
\te.ServeHTTP(rec, req)
\treturn rec
}
`,
  "pkg/webtests/transfers_test.go": `package webtests

import (
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/labstack/echo/v4"
)

func squadRequest(t *testing.T, e *echo.Echo, club string) *httptest.ResponseRecorder {
\tt.Helper()
\treq := httptest.NewRequest(http.MethodGet, "/api/v2/clubs/"+club+"/squad", nil)
\trec := httptest.NewRecorder()
\te.ServeHTTP(rec, req)
\treturn rec
}

func TestTransfer(t *testing.T) {
\te := echo.New()
\trec := leagueRequest(t, e, http.MethodPost, "/api/v2/clubs/3/transfers", "{}")
\t_ = rec
}

func TestSquad(t *testing.T) {
\te := echo.New()
\t_ = squadRequest(t, e, "3")
}
`,
};

describe("a Go test's in-process request reaches the handler it requests", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-go-test-requests-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links each request to its route as a test's", () => {
    const links = (summary.apiRouteLinks ?? []).filter((l) => l.source.startsWith("pkg/webtests/"));
    expect(links.map((l) => `${l.source}:${l.sourceLine} ${l.method} ${l.routePath} ${l.sourceRole}`).sort()).toEqual([
      "pkg/webtests/transfers_test.go:13 GET /api/v2/clubs/:club/squad test",
      "pkg/webtests/transfers_test.go:21 POST /api/v2/clubs/:club/transfers test",
    ]);
  });

  it("calls what the requested handlers run tested, and the unrequested handler's untested", async () => {
    const file = async (path: string) => JSON.parse(await readFile(join(dir, "out", `${path}.json`), "utf-8")) as FileAnalysis;
    const verdict = async (path: string) => fileTestVerdict(summary, path, await file(path));
    expect((await verdict("pkg/ledger/transfers.go")).state).toBe("tested");
    expect((await verdict("pkg/ledger/squad.go")).state).toBe("tested");
    expect((await verdict("pkg/ledger/scouting.go")).state).toBe("untested");
  });
});
