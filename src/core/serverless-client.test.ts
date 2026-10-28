import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A Serverless Framework API and the React client that calls it through Amplify
 * (real-repo shape): handlers exported through a wrapper, calls naming the API
 * first, v5 route wrappers inside `<Switch>`, `history.push` and `LinkContainer`.
 */
const FILES: Record<string, string> = {
  "api/serverless.yml": `service: league-api
provider:
  name: aws
  runtime: nodejs18.x
functions:
  list:
    handler: list.main
    events:
      - http:
          path: clubs
          method: get
  get:
    handler: get.main
    events:
      - http:
          path: clubs/{id}
          method: get
  remove:
    handler: remove.main
    events:
      - http:
          path: clubs/{id}
          method: delete
`,
  "api/libs/handler-lib.js": `export default function handler(lambda) {
  return async function (event, context) {
    const body = await lambda(event, context);
    return { statusCode: 200, body: JSON.stringify(body) };
  };
}
`,
  "api/list.js": `import handler from "./libs/handler-lib";
export const main = handler(async (event) => {
  return [];
});
`,
  "api/get.js": `import handler from "./libs/handler-lib";
export const main = handler(async (event) => {
  return { id: event.pathParameters.id };
});
`,
  "api/remove.js": `import handler from "./libs/handler-lib";
export const main = handler(async (event) => {
  return { status: true };
});
`,
  "client/package.json": `{ "name": "league-client", "dependencies": { "react": "^17.0.0", "react-router-dom": "^5.2.0", "aws-amplify": "^3.0.0" } }`,
  "client/src/Routes.js": `import React from "react";
import { Route, Switch } from "react-router-dom";
import Clubs from "./containers/Clubs";
import Club from "./containers/Club";
import Login from "./containers/Login";
import AuthenticatedRoute from "./components/AuthenticatedRoute";

export default function Routes() {
  return (
    <Switch>
      <Route exact path="/">
        <Clubs />
      </Route>
      <Route exact path="/login">
        <Login />
      </Route>
      <AuthenticatedRoute exact path="/clubs/:id">
        <Club />
      </AuthenticatedRoute>
    </Switch>
  );
}
`,
  "client/src/components/AuthenticatedRoute.js": `import React from "react";
import { Route } from "react-router-dom";
export default function AuthenticatedRoute({ children, ...rest }) {
  return <Route {...rest}>{children}</Route>;
}
`,
  "client/src/containers/Clubs.js": `import React from "react";
import { API } from "aws-amplify";
import { LinkContainer } from "react-router-bootstrap";

export default function Clubs({ clubs }) {
  function loadClubs() {
    return API.get("league", "/clubs");
  }
  return (
    <div>
      {clubs.map((c) => (
        <LinkContainer key={c.id} to={\`/clubs/\${c.id}\`}>
          <span>{c.name}</span>
        </LinkContainer>
      ))}
    </div>
  );
}
`,
  "client/src/containers/Club.js": `import React from "react";
import { API } from "aws-amplify";
import { useHistory, useParams } from "react-router-dom";

export default function Club() {
  const { id } = useParams();
  const history = useHistory();
  function loadClub() {
    return API.get("league", \`/clubs/\${id}\`);
  }
  async function handleDelete() {
    await API.del("league", \`/clubs/\${id}\`);
    history.push("/");
  }
  return <button onClick={handleDelete}>Delete</button>;
}
`,
  "client/src/containers/Login.js": `import React from "react";
export default function Login() {
  return <form />;
}
`,
};

describe("a serverless API and its Amplify client", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-sls-"));
    const root = join(dir, "src");
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("anchors each route on the handler a wrapper exports, and links each call to it by its path", async () => {
    const s = await loadReportSummary(out);
    expect(s.routeMap.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} ${r.filePath}:${r.line}`).sort()).toEqual([
      "DELETE /clubs/{id} api/remove.js:2",
      "GET /clubs api/list.js:2",
      "GET /clubs/{id} api/get.js:2",
    ]);
    expect((s.apiRouteLinks ?? []).map((l) => `${l.source}:${l.sourceLine} ${l.method} -> ${l.target}`).sort()).toEqual([
      "client/src/containers/Club.js:12 DELETE -> api/remove.js",
      "client/src/containers/Club.js:9 GET -> api/get.js",
      "client/src/containers/Clubs.js:7 GET -> api/list.js",
    ]);
  });

  it("mounts a route wrapper inside <Switch>, and reads history.push and LinkContainer as navigation", async () => {
    const s = await loadReportSummary(out);
    const screens = new Map(s.screens.filter((x) => x.filePath.includes("/containers/")).map((x) => [x.name, x]));
    expect(screens.get("Club")?.routePath).toBe("/clubs/:id");
    expect(screens.get("Club")?.navigatesTo).toEqual(["/"]);
    // `/clubs/${c.id}` reads as the page's own route.
    expect(screens.get("Clubs")?.navigatesTo).toEqual(["/clubs/:id"]);
  });
});
