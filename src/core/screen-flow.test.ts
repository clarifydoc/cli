import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { buildScreenFlow, pathKey } from "./screen-flow.js";
import { redirectNames, redirectPaths } from "./server-redirects.js";
import type { ProjectAnalysis, RouteInfo, ScreenInfo } from "../types/analysis.js";

describe("redirectPaths", () => {
  it("reads the app path a redirect names", () => {
    expect(redirectPaths(`res.redirect("/login")`)).toEqual(["/login"]);
    expect(redirectPaths(`res.redirect(302, \`/clubs/\${club.id}?tab=squad\`)`)).toEqual(["/clubs/{}"]);
    expect(redirectPaths(`return RedirectResponse(url="/garage", status_code=303)`)).toEqual(["/garage"]);
    expect(redirectPaths(`return "redirect:/clubs";`)).toEqual(["/clubs"]);
    expect(redirectPaths(`redirect_to "/garage", notice: "Saved"`)).toEqual(["/garage"]);
    expect(redirectPaths(`header("Location: /match/" . $id);`)).toEqual(["/match/{}"]);
    expect(redirectPaths(`c.Redirect(http.StatusFound, "/league")`)).toEqual(["/league"]);
    expect(redirectPaths(`res.redirect("/clubs/" + club.id)`)).toEqual(["/clubs/{}"]);
  });

  it("leaves URLs of other hosts and names alone", () => {
    expect(redirectPaths(`res.redirect("https://example.com/x")`)).toEqual([]);
    expect(redirectPaths(`res.redirect("//cdn.example.com")`)).toEqual([]);
    expect(redirectPaths(`return RedirectToAction("Index")`)).toEqual([]);
  });
});

describe("redirectNames", () => {
  it("reads the action or endpoint a redirect names", () => {
    expect(redirectNames(`return redirect(url_for("table"))`)).toEqual([{ name: "table" }]);
    expect(redirectNames(`return RedirectToAction("Index", "Clubs");`)).toEqual([{ name: "Index", controller: "Clubs" }]);
    expect(redirectNames(`return RedirectToAction(nameof(Details));`)).toEqual([{ name: "Details" }]);
    expect(redirectNames(`redirect(action: "list", controller: "garage")`)).toEqual([{ name: "list", controller: "garage" }]);
  });
});

describe("pathKey", () => {
  it("compares parameters alike and keeps the root", () => {
    expect(pathKey("/clubs/:id/")).toBe(pathKey("/clubs/{clubId}"));
    expect(pathKey("/")).toBe("/");
    expect(pathKey("")).toBe("/");
  });

  it("keeps a catch-all apart from a parameter", () => {
    expect(pathKey("*")).toBe("/**");
    expect(pathKey("/:path+")).toBe("/**");
    expect(pathKey("/docs/[...slug]")).toBe("/docs/**");
    expect(pathKey("/clubs/:id")).toBe("/clubs/{}");
  });
});

const screen = (filePath: string, name: string, routePath: string | null, navigatesTo: string[] = [], extra: Partial<ScreenInfo> = {}): ScreenInfo => ({
  name, formType: "page", caption: null, dimensions: null, components: [], filePath, routePath, navigatesTo, ...extra,
});
const route = (path: string, extra: Partial<RouteInfo & { filePath: string }>): RouteInfo & { filePath: string } => ({
  path, httpMethod: null, kind: "frontend", handler: null, line: 1, filePath: "src/router.ts", ...extra,
} as RouteInfo & { filePath: string });

describe("buildScreenFlow", () => {
  it("types each edge and starts at the redirect from /", () => {
    const flow = buildScreenFlow({
      screens: [
        screen("src/pages/Dashboard.vue", "Dashboard", "/dashboard", ["/clubs/42"]),
        screen("src/pages/Clubs.vue", "Clubs", "/clubs/:id"),
        screen("src/pages/Login.vue", "Login", "/login"),
        screen("src/components/NavBar.vue", "NavBar", null, ["/login"]),
        screen("src/dialogs/TransferDialog.vue", "TransferDialog", null),
      ],
      routes: [
        route("/", { redirectTo: "/dashboard" }),
        route("/logout", { kind: "api", httpMethod: "POST", filePath: "server/app.ts", redirectsTo: ["/login"] }),
      ],
      launches: [{ sourceFile: "src/pages/Clubs.vue", sourceSymbol: "openTransfer", targetFile: "src/dialogs/TransferDialog.vue", launcher: "openTransfer", line: 9 }],
      elements: [{ element: "form", event: "submit", handler: null, line: 4, filePath: "src/pages/Dashboard.vue", request: { method: "POST", target: "/logout" } }],
      componentGraph: { "src/pages/Dashboard.vue": ["src/components/NavBar.vue"] },
      projectOf: () => undefined,
    })!;
    const edge = (kind: string) => flow.edges.filter((e) => e.kind === kind).map((e) => `${e.from} -> ${e.to}`);
    expect(flow.nodes.find((n) => n.start)?.id).toBe("path:/");
    expect(edge("redirect")).toEqual(["path:/ -> src/pages/Dashboard.vue"]);
    // The NavBar's link counts from the one page using it; the form's POST /logout redirects on to the login page.
    expect(edge("navigate").sort()).toEqual(["src/pages/Dashboard.vue -> src/pages/Clubs.vue", "src/pages/Dashboard.vue -> src/pages/Login.vue"]);
    expect(edge("server-redirect")).toEqual(["src/pages/Dashboard.vue -> src/pages/Login.vue"]);
    expect(edge("dialog")).toEqual(["src/pages/Clubs.vue -> src/dialogs/TransferDialog.vue"]);
    expect(flow.nodes.find((n) => n.id === "src/dialogs/TransferDialog.vue")?.kind).toBe("dialog");
    expect(flow.nodes.some((n) => n.id === "src/components/NavBar.vue")).toBe(false);
  });
});

/** A server-rendered app: a login form posts to a route that redirects to the league table by endpoint name. */
const FILES: Record<string, string> = {
  "requirements.txt": "flask\n",
  "app.py": `from flask import Flask, render_template, redirect, url_for, request

app = Flask(__name__)


@app.route("/")
def home():
    return render_template("home.html")


@app.route("/login", methods=["GET"])
def login_form():
    return render_template("login.html")


@app.route("/login", methods=["POST"])
def login():
    if request.form["password"] == "":
        return redirect("/login")
    return redirect(url_for("table"))


@app.route("/table")
def table():
    return render_template("table.html")
`,
  "templates/home.html": `{% extends "base.html" %}\n{% block content %}<h1>League</h1>\n<a href="/login">Sign in</a>\n{% endblock %}\n`,
  "templates/login.html": `{% extends "base.html" %}\n{% block content %}<h1>Sign in</h1>\n<form method="post" action="/login">\n  <input name="password">\n  <button type="submit">Go</button>\n</form>\n{% endblock %}\n`,
  "templates/table.html": `{% extends "base.html" %}\n{% block content %}<h1>League table</h1>\n<a href="/">Home</a>\n{% endblock %}\n`,
};

describe("screen flow of a server-rendered app", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "screen-flow-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("records where the POST route redirects", () => {
    const post = summary.routeMap.find((r) => r.path === "/login" && r.httpMethod === "POST");
    expect(post?.redirectsTo?.sort()).toEqual(["/table"]);
  });

  it("follows the form through the server redirect, from the page at /", () => {
    const flow = summary.screenFlow!;
    expect(flow.nodes.find((n) => n.start)?.id).toBe("templates/home.html");
    const edges = flow.edges.map((e) => `${e.kind}: ${e.from} -> ${e.to}`);
    expect(edges).toContain("navigate: templates/home.html -> templates/login.html");
    expect(edges).toContain("server-redirect: templates/login.html -> templates/table.html");
  });
});

/** Real-repo FP: a file-routed Vue app whose sidebar, two components deep under the `/` layout route, links by route name. */
const VUE_FILES: Record<string, string> = {
  "package.json": `{ "name": "league-spa", "dependencies": { "vue": "^3.4.0", "vue-router": "^4.3.0", "unplugin-vue-router": "^0.8.0" } }\n`,
  "vite.config.ts": `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import VueRouter from "unplugin-vue-router/vite";

export default defineConfig({ plugins: [VueRouter({ routesFolder: "src/routes" }), vue()] });
`,
  "src/routes/index.vue": `<template>
  <LeagueLayout>
    <template #content><RouterView /></template>
  </LeagueLayout>
</template>

<script setup lang="ts">
import LeagueLayout from "../ui/LeagueLayout.vue";
import { RouterView } from "vue-router";
</script>
`,
  "src/ui/LeagueLayout.vue": `<template>
  <div class="layout"><AppSidebar /><main><slot name="content" /></main></div>
</template>

<script setup lang="ts">
import AppSidebar from "../components/AppSidebar.vue";
</script>
`,
  "src/components/AppSidebar.vue": `<template>
  <nav>
    <RouterLink :to="{ name: '//clubs/' }">Clubs</RouterLink>
    <RouterLink to="/garage">Garage</RouterLink>
    <RouterLink v-for="item in items" :key="item.label" :to="item.to">{{ item.label }}</RouterLink>
  </nav>
</template>

<script setup lang="ts">
import { RouterLink } from "vue-router";
const items = [{ label: "Table", to: { name: "//league/table" } }];
</script>
`,
  "src/routes/index/clubs/index.vue": `<template><h1>Clubs</h1><button @click="open">Open</button></template>\n<script setup lang="ts">\nfunction open() {}\n</script>\n`,
  "src/routes/index/garage.vue": `<template><h1>Garage</h1></template>\n`,
  "src/routes/index/league/table.vue": `<template><h1>Table</h1></template>\n`,
};

describe("screen flow of a file-routed Vue app", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "screen-flow-vue-"));
    for (const [rel, text] of Object.entries(VUE_FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("names file-based routes as unplugin-vue-router does", () => {
    const name = (path: string) => summary.routeMap.find((r) => r.kind === "frontend" && r.path === path)?.routeName;
    expect(name("/clubs")).toBe("//clubs/");
    expect(name("/league/table")).toBe("//league/table");
  });

  it("counts the sidebar's links for the page whose layout holds it", () => {
    const edges = summary.screenFlow!.edges.filter((e) => e.from === "src/routes/index.vue").map((e) => `${e.kind}: ${e.to}`);
    expect(edges.sort()).toEqual([
      "navigate: src/routes/index/clubs/index.vue",
      "navigate: src/routes/index/garage.vue",
      "navigate: src/routes/index/league/table.vue",
    ]);
    expect(summary.screenFlow!.nodes.find((n) => n.start)?.id).toBe("src/routes/index.vue");
  });
});

/** Real-repo FP: React Router pages loaded through `lazy()`, one page at two paths, a catch-all, and pages importing a layout's context. */
const REACT_FILES: Record<string, string> = {
  "package.json": `{ "name": "garage-web", "dependencies": { "react": "^18.3.0", "react-router-dom": "^6.26.0" } }\n`,
  "src/App.tsx": `import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import GarageLayout from "./layout/GarageLayout";

const SignIn = lazy(() => import("./pages/SignIn"));
const CarList = lazy(() => import("./pages/CarList"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Workshop = lazy(() => import("./pages/Workshop").then((m) => ({ default: m.Workshop })));

// A route element of this file: the page it renders, keyed by the car.
const WorkshopRoute = () => {
  const { carId } = useParams();
  return <Workshop key={carId} />;
};

// Old links land on the new page.
const OldServiceLink = ({ prefix = "/workshop" }: { prefix?: string }) => {
  const { carId } = useParams();
  return <Navigate to={carId ? \`\${prefix}/\${carId}\` : prefix} replace />;
};

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<SignIn />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route element={<GarageLayout />}>
            <Route path="/cars" element={<CarList />} />
            <Route path="/garage" element={<Navigate to="/cars" replace />} />
            <Route path="/workshop/:carId?" element={<WorkshopRoute />} />
            <Route path="/service/:carId" element={<OldServiceLink />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
`,
  "src/layout/GarageLayout.tsx": `import { createContext } from "react";
import { Link, Outlet } from "react-router-dom";

export const CrumbsContext = createContext<string[]>([]);

export default function GarageLayout() {
  return (
    <div>
      <nav><Link to="/settings">Settings</Link></nav>
      <Outlet />
    </div>
  );
}
`,
  "src/pages/SignIn.tsx": `import { useNavigate } from "react-router-dom";

export default function SignIn() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/cars")}>Sign in</button>;
}
`,
  "src/pages/CarList.tsx": `import { useContext } from "react";
import { Link } from "react-router-dom";
import { CrumbsContext } from "../layout/GarageLayout";

export default function CarList() {
  const crumbs = useContext(CrumbsContext);
  return <div><h1>{crumbs.join(" / ")}</h1><Link to="/sign-in">Sign out</Link></div>;
}
`,
  "src/pages/Workshop.tsx": `export function Workshop() {\n  return <h1>Workshop</h1>;\n}\n`,
  "src/pages/NotFound.tsx": `export default function NotFound() {\n  return <h1>Not found</h1>;\n}\n`,
};

describe("screen flow of a React Router app", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "screen-flow-react-"));
    for (const [rel, text] of Object.entries(REACT_FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("routes each lazily loaded page, at every path it answers", () => {
    const screen = (f: string) => summary.screens.find((s) => s.filePath === f);
    expect(screen("src/pages/SignIn.tsx")).toMatchObject({ routePath: "/", otherRoutes: ["/sign-in"] });
    expect(screen("src/pages/CarList.tsx")?.routePath).toBe("/cars");
    // Through a wrapper of App.tsx, to a named export loaded lazily.
    expect(screen("src/pages/Workshop.tsx")?.routePath).toBe("/workshop/:carId?");
  });

  it("reads a wrapper that only redirects as a redirect, to a page with an optional parameter", () => {
    const service = summary.routeMap.find((r) => r.path === "/service/:carId");
    expect(service).toMatchObject({ redirectTo: "/workshop", componentPath: null });
    const edges = summary.screenFlow!.edges.map((e) => `${e.kind}: ${e.from} -> ${e.to}`);
    expect(edges).toContain("redirect: path:/service/{} -> src/pages/Workshop.tsx");
  });

  it("links to the page at a second path, never to the catch-all, and not through an imported context", () => {
    const flow = summary.screenFlow!;
    const edges = flow.edges.map((e) => `${e.kind}: ${e.from} -> ${e.to}`);
    expect(edges).toContain("navigate: src/pages/SignIn.tsx -> src/pages/CarList.tsx");
    expect(edges).toContain("navigate: src/pages/CarList.tsx -> src/pages/SignIn.tsx");
    expect(edges).toContain("redirect: path:/garage -> src/pages/CarList.tsx");
    expect(edges.filter((e) => e.endsWith("src/pages/NotFound.tsx"))).toEqual([]);
    // CarList imports only the layout's context: the layout's own link is not CarList's.
    expect(flow.edges.filter((e) => e.from === "src/pages/CarList.tsx").map((e) => e.via)).toEqual(["/sign-in"]);
    // The page at `/`, and the layout framing the routes inside it (`<Outlet />`), a shell.
    expect(flow.nodes.filter((n) => n.start).map((n) => n.id).sort()).toEqual(["src/layout/GarageLayout.tsx", "src/pages/SignIn.tsx"]);
  });
});

/** Real-repo FP: a Vue app whose layout (mounted by `<component :is>`) frames the router view, and pages that build their links. */
const SHELL_FILES: Record<string, string> = {
  "package.json": `{ "name": "garage-admin", "dependencies": { "vue": "^2.7.0", "vue-router": "^3.6.0" } }\n`,
  "src/router.js": `import VueRouter from "vue-router";
const routes = [
  { path: "/", component: () => import("./pages/Home.vue") },
  { path: "/cars", component: () => import("./pages/CarList.vue") },
  { path: "/cars/:id", component: () => import("./pages/CarDetails.vue") },
  { path: "/garage/settings", component: () => import("./pages/Settings.vue") },
];
export default new VueRouter({ mode: "history", routes });
`,
  "src/App.vue": `<template>
  <component :is="layout" />
</template>

<script>
import MainLayout from "./layouts/MainLayout.vue";
export default { components: { MainLayout }, computed: { layout() { return "MainLayout"; } } };
</script>
`,
  "src/layouts/MainLayout.vue": `<template>
  <div><GarageMenu /><router-view /></div>
</template>

<script>
import GarageMenu from "../components/GarageMenu.vue";
export default { components: { GarageMenu } };
</script>
`,
  "src/components/GarageMenu.vue": `<template>
  <ul><li v-for="link in links" :key="link.ref"><router-link :to="link.ref">{{ link.text }}</router-link></li></ul>
</template>

<script>
export default { data: () => ({ links: [{ text: "Cars", ref: "/cars" }, { text: "Settings", ref: "garage/settings" }] }) };
</script>
`,
  "src/pages/Home.vue": `<template><h1>Garage</h1></template>\n`,
  "src/pages/CarList.vue": `<template>
  <div>
    <button @click="open(car)">Open</button>
    <a :href="\`/cars/\${car.id}\`">Details</a>
  </div>
</template>

<script>
export default {
  methods: {
    open(car) { this.$router.push("/cars/" + car.id); },
    popOut(id) { window.open("/cars/" + id, "_blank"); },
  },
};
</script>
`,
  "src/pages/CarDetails.vue": `<template><button @click="back">Back</button></template>

<script>
export default {
  methods: {
    back() {
      let url = window.location.origin + "/cars";
      window.open(url);
    },
    download(id) { window.open("/api/files?id=" + id); },
  },
};
</script>
`,
  "src/pages/Settings.vue": `<template><h1>Settings</h1></template>\n`,
};

describe("screen flow of a Vue app framed by a layout", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "screen-flow-shell-"));
    for (const [rel, text] of Object.entries(SHELL_FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("hangs the menu's links off the layout that frames the router view", () => {
    const flow = summary.screenFlow!;
    expect(flow.nodes.find((n) => n.id === "src/layouts/MainLayout.vue")).toMatchObject({ kind: "shell", start: true });
    const fromShell = flow.edges.filter((e) => e.from === "src/layouts/MainLayout.vue").map((e) => e.to).sort();
    expect(fromShell).toEqual(["src/pages/CarList.vue", "src/pages/Settings.vue"]);
  });

  it("reads links built by concatenation, interpolation and a URL variable, not a download", () => {
    const edges = summary.screenFlow!.edges.map((e) => `${e.from} -> ${e.to}`);
    expect(edges).toContain("src/pages/CarList.vue -> src/pages/CarDetails.vue");
    expect(edges).toContain("src/pages/CarDetails.vue -> src/pages/CarList.vue");
    // The download is read as a target but names no screen: no edge.
    expect(summary.screenFlow!.edges.filter((e) => e.from === "src/pages/CarDetails.vue").map((e) => e.to)).toEqual(["src/pages/CarList.vue"]);
  });
});

/** Real-repo FP: a Blazor shop with a shared component library, and a MAUI Shell app navigating from its view models. */
const DOTNET_FILES: Record<string, string> = {
  "Garage.Web/Garage.Web.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><ProjectReference Include="../Garage.Components/Garage.Components.csproj" /></ItemGroup></Project>\n`,
  "Garage.Web/Components/Layout/MainLayout.razor": `@inherits LayoutComponentBase
<TopBar />
<main>@Body</main>
`,
  "Garage.Web/Components/Layout/TopBar.razor": `<nav>
  <a href="">Showroom</a>
  <a href="cart">Cart</a>
</nav>
`,
  "Garage.Web/Components/Pages/Showroom.razor": `@page "/"
@foreach (var car in cars)
{
    <CarCard Car="car" />
}
@code {
    private List<Car> cars = new();
}
`,
  "Garage.Web/Components/Pages/CartPage.razor": `@page "/cart"
@inject NavigationManager Nav
<button @onclick="Order">Order</button>
@code {
    void Order()
    {
        // Nav.NavigateTo("secret");
        Nav.NavigateTo("orders");
    }
}
`,
  "Garage.Web/Components/Pages/Orders.razor": `@page "/orders"\n<h1>Orders</h1>\n`,
  "Garage.Web/Components/Pages/CarPage.razor": `@page "/car/{carId:int}"\n<h1>Car</h1>\n`,
  "Garage.Web/Services/CarService.cs": `namespace Garage.Web.Services;
using Garage.Components;
public class CarService
{
    public string LinkTo(Car car) => CarLinks.Url(car);
}
`,
  "Garage.Components/Garage.Components.csproj": `<Project Sdk="Microsoft.NET.Sdk.Razor"></Project>\n`,
  "Garage.Components/CarCard.razor": `<a class="car" href="@CarLinks.Url(Car)">@Car.Name</a>
@code {
    [Parameter] public Car Car { get; set; } = default!;
}
`,
  "Garage.Components/CarLinks.cs": `namespace Garage.Components;
public record Car(int Id, string Name);
public static class CarLinks
{
    public static string Url(Car car) => $"car/{car.Id}";
}
`,
  "Pit.App/Pit.App.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseMaui>true</UseMaui></PropertyGroup></Project>\n`,
  "Pit.App/AppShell.xaml": `<?xml version="1.0" encoding="utf-8" ?>
<Shell xmlns="http://schemas.microsoft.com/dotnet/2021/maui" xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml" xmlns:views="clr-namespace:Pit.App.Views" x:Class="Pit.App.AppShell">
    <TabBar Route="Main">
        <ShellContent Title="Garage" Route="Garage" ContentTemplate="{DataTemplate views:GarageView}" />
    </TabBar>
</Shell>
`,
  "Pit.App/AppShell.xaml.cs": `namespace Pit.App;
public partial class AppShell : Shell
{
    public AppShell()
    {
        InitializeComponent();
        Routing.RegisterRoute("Service", typeof(Views.ServiceView));
    }
}
`,
  "Pit.App/Views/GarageView.xaml": `<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui" xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml" xmlns:viewmodels="clr-namespace:Pit.App.ViewModels" x:Class="Pit.App.Views.GarageView" x:DataType="viewmodels:GarageViewModel" Title="Garage">
    <Button Text="Service" Command="{Binding ServiceCommand}" />
</ContentPage>
`,
  "Pit.App/Views/GarageView.xaml.cs": `namespace Pit.App.Views;
public partial class GarageView : ContentPage
{
    public GarageView() { InitializeComponent(); }
}
`,
  "Pit.App/Views/ServiceView.xaml": `<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui" xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml" x:Class="Pit.App.Views.ServiceView" Title="Service">
    <Label Text="Service" />
</ContentPage>
`,
  "Pit.App/Views/ServiceView.xaml.cs": `namespace Pit.App.Views;
public partial class ServiceView : ContentPage
{
    public ServiceView() { InitializeComponent(); }
}
`,
  "Pit.App/ViewModels/GarageViewModel.cs": `namespace Pit.App.ViewModels;
public class GarageViewModel
{
    public async Task ServiceAsync() => await Shell.Current.GoToAsync("Service");
}
`,
};

describe("screen flow of Blazor and MAUI apps", () => {
  let dir: string;
  let flow: NonNullable<ProjectAnalysis["screenFlow"]>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "screen-flow-dotnet-"));
    for (const [rel, text] of Object.entries(DOTNET_FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    flow = (await loadReportSummary(join(dir, "out"))).screenFlow!;
  }, 180_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  const edges = () => flow.edges.map((e) => `${e.from} -> ${e.to}`);

  it("frames Blazor pages with the layout that writes @Body, its bar's base-relative links its own", () => {
    expect(flow.nodes.find((n) => n.id === "Garage.Web/Components/Layout/MainLayout.razor")).toMatchObject({ kind: "shell" });
    expect(edges()).toContain("Garage.Web/Components/Layout/MainLayout.razor -> Garage.Web/Components/Pages/CartPage.razor");
    expect(edges()).toContain("Garage.Web/Components/Layout/MainLayout.razor -> Garage.Web/Components/Pages/Showroom.razor");
  });

  it("follows a library component's link helper to the page of the app rendering it, and skips a commented-out call", () => {
    expect(edges()).toContain("Garage.Web/Components/Pages/Showroom.razor -> Garage.Web/Components/Pages/CarPage.razor");
    expect(flow.edges.filter((e) => e.from === "Garage.Web/Components/Pages/CartPage.razor").map((e) => e.via)).toEqual(["/orders"]);
  });

  it("routes MAUI Shell pages and follows the view model's navigation", () => {
    expect(flow.nodes.find((n) => n.id === "Pit.App/AppShell.xaml")).toMatchObject({ kind: "shell" });
    expect(edges()).toContain("Pit.App/AppShell.xaml -> Pit.App/Views/GarageView.xaml");
    expect(edges()).toContain("Pit.App/Views/GarageView.xaml -> Pit.App/Views/ServiceView.xaml");
    expect(flow.nodes.find((n) => n.id === "Pit.App/Views/GarageView.xaml")?.path).toBe("/Main/Garage");
  });
});
