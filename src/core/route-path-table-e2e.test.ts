import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A path table as the app's one source of URLs, end to end (real-repo FP): `paths.ts` is an
 * `as const` object whose entries hold the router's `path` and a `getHref` building the link.
 * The data router composes `paths.app.clubs.path` under `paths.app.root.path`, an index
 * child's `''` included; every link is `paths.x.getHref(…)` — in `navigate(…)`, `<Link to>`
 * and a sidebar item's `to:`. The Vite mount document at `/` is no page a link opens.
 */
describe("a route path table, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-path-table-"));
    const root = join(dir, "web");
    const src = join(root, "src");
    for (const d of ["config", "app/routes/app", "components"]) await mkdir(join(src, d), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "web", dependencies: { react: "18.3.1", "react-router": "7.0.0" } }));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    await writeFile(join(root, "index.html"), [
      "<!doctype html>",
      "<html><head><title>League</title></head>",
      '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    ].join("\n"));
    await writeFile(join(src, "config", "paths.ts"), [
      "export const paths = {",
      "  home: { path: '/', getHref: () => '/' },",
      "  auth: {",
      "    login: {",
      "      path: '/auth/login',",
      "      getHref: (redirectTo?: string | null) =>",
      "        `/auth/login${redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ''}`,",
      "    },",
      "  },",
      "  app: {",
      "    root: { path: '/app', getHref: () => '/app' },",
      "    dashboard: { path: '', getHref: () => '/app' },",
      "    clubs: { path: 'clubs', getHref: () => '/app/clubs' },",
      "    club: { path: 'clubs/:clubId', getHref: (id: string) => `/app/clubs/${id}` },",
      "  },",
      "} as const;",
    ].join("\n"));
    await writeFile(join(src, "app", "router.tsx"), [
      "import { createBrowserRouter } from 'react-router';",
      "import { paths } from '@/config/paths';",
      "import AppRoot from './routes/app/root';",
      "export const router = createBrowserRouter([",
      "  { path: paths.home.path, lazy: () => import('./routes/landing') },",
      "  { path: paths.auth.login.path, lazy: () => import('./routes/login') },",
      "  {",
      "    path: paths.app.root.path,",
      "    element: <AppRoot />,",
      "    children: [",
      "      { path: paths.app.clubs.path, lazy: () => import('./routes/app/clubs') },",
      "      { path: paths.app.club.path, lazy: () => import('./routes/app/club') },",
      "      { path: paths.app.dashboard.path, lazy: () => import('./routes/app/dashboard') },",
      "    ],",
      "  },",
      "]);",
    ].join("\n"));
    await writeFile(join(src, "app", "routes", "landing.tsx"), [
      "import { useNavigate } from 'react-router';",
      "import { paths } from '@/config/paths';",
      "export default function Landing() {",
      "  const navigate = useNavigate();",
      "  return <button onClick={() => navigate(paths.app.dashboard.getHref())}>Start</button>;",
      "}",
    ].join("\n"));
    await writeFile(join(src, "app", "routes", "login.tsx"), [
      "import { Link } from 'react-router';",
      "import { paths } from '@/config/paths';",
      "export default function Login() {",
      "  return <Link to={paths.home.getHref()}>Home</Link>;",
      "}",
    ].join("\n"));
    await writeFile(join(src, "components", "sidebar.tsx"), [
      "import { NavLink } from 'react-router';",
      "import { paths } from '@/config/paths';",
      "export function Sidebar() {",
      "  const items = [",
      "    { name: 'Dashboard', to: paths.app.dashboard.getHref() },",
      "    { name: 'Clubs', to: paths.app.clubs.getHref() },",
      "  ];",
      "  return <nav>{items.map((item) => <NavLink key={item.name} to={item.to}>{item.name}</NavLink>)}</nav>;",
      "}",
    ].join("\n"));
    await writeFile(join(src, "app", "routes", "app", "root.tsx"), [
      "import { Outlet } from 'react-router';",
      "import { Sidebar } from '@/components/sidebar';",
      "export default function AppRoot() {",
      "  return <div><Sidebar /><Outlet /></div>;",
      "}",
    ].join("\n"));
    await writeFile(join(src, "app", "routes", "app", "dashboard.tsx"), "export default function Dashboard() { return <h1>Dashboard</h1>; }\n");
    await writeFile(join(src, "app", "routes", "app", "clubs.tsx"), [
      "import { Link } from 'react-router';",
      "import { paths } from '@/config/paths';",
      "export default function Clubs({ ids }: { ids: string[] }) {",
      "  return <ul>{ids.map((id) => <li key={id}><Link to={paths.app.club.getHref(id)}>{id}</Link></li>)}</ul>;",
      "}",
    ].join("\n"));
    await writeFile(join(src, "app", "routes", "app", "club.tsx"), [
      "import { useNavigate } from 'react-router';",
      "import { paths } from '@/config/paths';",
      "export default function Club() {",
      "  const navigate = useNavigate();",
      "  return <button onClick={() => navigate(paths.auth.login.getHref('/app'))}>Sign in</button>;",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("composes children under a parent the path table names, the index child at the parent's path", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const screens = Object.fromEntries((s.screens ?? []).filter((x) => x.routePath).map((x) => [x.filePath.replace(/^src\/app\/routes\//, ""), x.routePath]));
    expect(screens).toMatchObject({
      "landing.tsx": "/",
      "app/root.tsx": "/app",
      "app/dashboard.tsx": "/app",
      "app/clubs.tsx": "/app/clubs",
      "app/club.tsx": "/app/clubs/:clubId",
    });
  });

  it("follows every link through the table's getHref to the screen at its path", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const short = (f: string) => f.replace(/^src\/app\/routes\//, "");
    const edges = (s.screenFlow?.edges ?? []).map((e) => `${short(e.from)} -> ${short(e.to)}`).sort();
    expect(edges).toEqual(expect.arrayContaining([
      // `navigate(paths.app.dashboard.getHref())`: `/app` opens the index page, not the layout around it.
      "landing.tsx -> app/dashboard.tsx",
      // `<Link to={paths.home.getHref()}>`: the routed page at `/`, not the Vite mount document.
      "login.tsx -> landing.tsx",
      // The sidebar's `to: paths.app.clubs.getHref()`, on the layout that renders it.
      "app/root.tsx -> app/clubs.tsx",
      // `getHref(id)` builds `/app/clubs/${id}`: the parameter, not a cut-off literal.
      "app/clubs.tsx -> app/club.tsx",
      // A query string the helper adds is no part of the path.
      "app/club.tsx -> login.tsx",
    ]));
    expect(edges.some((e) => e.endsWith("-> index.html"))).toBe(false);
  });
});
