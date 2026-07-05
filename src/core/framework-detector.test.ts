import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { detectFrameworksAcrossRoots } from "./framework-detector.js";

/**
 * Mirrors the match-centre layout: a wrapper root whose only manifest is a stub
 * package.json, a nested Rails app (`server/Gemfile`), and a nested Vue SPA
 * (`spa/package.json`). A root-only scan finds none of the real frameworks.
 */
describe("detectFrameworksAcrossRoots", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "revdoc-fw-"));
    // Stub root manifest — no real deps (only dev tooling), exactly like match-centre's root.
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { "baseline-browser-mapping": "^2.9.0" } }),
    );
    // A .sql file at the root so SQL is detected there (root-level signal).
    await writeFile(join(root, "schema.sql"), "CREATE TABLE absences (id integer primary key);");

    // Nested Rails backend.
    await mkdir(join(root, "server"), { recursive: true });
    await writeFile(
      join(root, "server", "Gemfile"),
      "source 'https://rubygems.org'\ngem 'rails', '~> 7.1.0'\n",
    );

    // Nested Vue SPA.
    await mkdir(join(root, "spa"), { recursive: true });
    await writeFile(
      join(root, "spa", "package.json"),
      JSON.stringify({ dependencies: { vue: "^3.4.0", "vue-router": "^4.6.0", quasar: "^2.13.0" } }),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects frameworks living in nested sub-project manifests, not just the root", async () => {
    const { merged } = await detectFrameworksAcrossRoots(root, ["", "server", "spa"]);
    const ids = merged.map((f) => f.id).sort();
    // Rails (Gemfile) and Vue/Vue Router (package.json) are nested — they must surface.
    expect(ids).toContain("active-record");
    expect(ids).toContain("vue");
    expect(ids).toContain("vue-router");
    // The root .sql signal still participates.
    expect(ids).toContain("sql");
  });

  it("does NOT detect the nested frameworks when only the root is scanned", async () => {
    // Regression guard for the original bug: root-only detection (subRoots = []).
    const { merged } = await detectFrameworksAcrossRoots(root, []);
    const ids = merged.map((f) => f.id);
    expect(ids).not.toContain("active-record");
    expect(ids).not.toContain("vue");
    // ...but the root-level SQL is still found.
    expect(ids).toContain("sql");
  });

  it("attributes each detection to the right sub-project root via byRoot", async () => {
    const { byRoot } = await detectFrameworksAcrossRoots(root, ["", "server", "spa"]);
    expect((byRoot.get("server") ?? []).map((f) => f.id)).toContain("active-record");
    const spaIds = (byRoot.get("spa") ?? []).map((f) => f.id);
    expect(spaIds).toContain("vue");
    expect(spaIds).toContain("vue-router");
    // The Rails backend isn't a Vue app, and vice versa.
    expect((byRoot.get("server") ?? []).map((f) => f.id)).not.toContain("vue");
    expect(spaIds).not.toContain("active-record");
  });

  it("de-dupes a framework present at multiple roots into one merged entry", async () => {
    // Add a second Vue package alongside spa; vue must still appear exactly once.
    await mkdir(join(root, "spa2"), { recursive: true });
    await writeFile(
      join(root, "spa2", "package.json"),
      JSON.stringify({ dependencies: { vue: "^3.4.0" } }),
    );
    const { merged } = await detectFrameworksAcrossRoots(root, ["spa", "spa2"]);
    expect(merged.filter((f) => f.id === "vue")).toHaveLength(1);
  });
});

describe("framework rules — UI / state-management coverage", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "revdoc-fw2-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          vue: "^3.4.0",
          quasar: "^2.13.0",
          "@quasar/extras": "^1.16.0",
          vuex: "^4.1.0",
          pinia: "^2.1.0",
          nuxt: "^3.10.0",
          "@reduxjs/toolkit": "^2.0.0",
          zustand: "^4.5.0",
          "@tanstack/react-query": "^5.0.0",
        },
      }),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects Quasar, Vuex, Pinia, Nuxt, Redux, Zustand and React Query from package.json", async () => {
    const { merged } = await detectFrameworksAcrossRoots(root, []);
    const ids = merged.map((f) => f.id);
    for (const id of ["quasar", "vuex", "pinia", "nuxt", "redux", "zustand", "react-query"]) {
      expect(ids).toContain(id);
    }
  });
});

describe("framework rules — .NET / Blazor / desktop", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "revdoc-fw-net-"));

    // A Blazor Hybrid desktop project (like DevToys): Razor SDK + Components +
    // MEF + WPF — and crucially NO Web SDK / AspNetCore.App, so it is NOT ASP.NET.
    await mkdir(join(root, "blazor"), { recursive: true });
    await writeFile(
      join(root, "blazor", "App.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk.Razor">
  <PropertyGroup>
    <UseWPF>true</UseWPF>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebView.Wpf" />
    <PackageReference Include="System.ComponentModel.Composition" />
  </ItemGroup>
</Project>`,
    );

    // A genuine ASP.NET Web API: the Web SDK is the discriminator.
    await mkdir(join(root, "api"), { recursive: true });
    await writeFile(
      join(root, "api", "Api.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Mvc.NewtonsoftJson" />
  </ItemGroup>
</Project>`,
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects Blazor + MEF + WPF for a Razor-SDK desktop project and does NOT call it ASP.NET", async () => {
    const { byRoot } = await detectFrameworksAcrossRoots(root, ["blazor"]);
    const ids = (byRoot.get("blazor") ?? []).map((f) => f.id);
    expect(ids).toContain("blazor");
    expect(ids).toContain("mef");
    expect(ids).toContain("wpf");
    // The keystone fix: a `.csproj` alone no longer means ASP.NET.
    expect(ids).not.toContain("aspnet");
  });

  it("still detects ASP.NET for a Web-SDK project", async () => {
    const { byRoot } = await detectFrameworksAcrossRoots(root, ["api"]);
    const ids = (byRoot.get("api") ?? []).map((f) => f.id);
    expect(ids).toContain("aspnet");
  });
});
