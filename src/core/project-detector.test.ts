import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { detectSubProjects } from "./project-detector.js";

describe("detectSubProjects — an Elixir project", () => {
  it("makes the directory of a mix.exs a sub-project of its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-mix-"));
    try {
      await mkdir(join(root, "src/league-ui/lib"), { recursive: true });
      await writeFile(join(root, "src/league-ui/mix.exs"), "defmodule LeagueUi.MixProject do\nend\n");
      await writeFile(join(root, "package.json"), "{}");
      const projects = await detectSubProjects(root);
      expect(projects.map((p) => `${p.root}:${p.kind}`).sort()).toEqual([":node", "src/league-ui:elixir"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("detectSubProjects — the package each JVM and .NET project publishes", () => {
  it("names a Gradle module by the root build's group and its directory, a Maven module by its parent's group, a .NET project by its one project file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-self-"));
    try {
      const files: Record<string, string> = {
        "settings.gradle": "rootProject.name = 'garage'\ninclude 'cars-api'\n",
        "build.gradle": "allprojects {\n  group = 'com.example.garage'\n}\n",
        "cars-api/build.gradle": "plugins { id 'java-library' }\n",
        "league/pom.xml": "<project><groupId>com.example.league</groupId><artifactId>league</artifactId><packaging>pom</packaging></project>",
        "league/club-api/pom.xml": "<project><parent><groupId>com.example.league</groupId><artifactId>league</artifactId></parent><artifactId>club-api</artifactId></project>",
        "Garage.Web/Garage.Web.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><AssemblyName>Garage.Site</AssemblyName></PropertyGroup></Project>',
        "Garage.Web/packages.config": '<packages><package id="Newtonsoft.Json" version="13.0.1" /></packages>',
        "Garage.Tests/Garage.Tests.csproj": '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.8.0" /></ItemGroup></Project>',
      };
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const projects = await detectSubProjects(root);
      expect(Object.fromEntries(projects.map((p) => [p.root, p.packageName ? `${p.packageEcosystem} ${p.packageName}` : null]))).toEqual({
        "": "gradle com.example.garage:garage",
        "cars-api": "gradle com.example.garage:cars-api",
        "league": "maven com.example.league:league",
        "league/club-api": "maven com.example.league:club-api",
        "Garage.Web": "nuget Garage.Site",
        "Garage.Tests": null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("detectSubProjects — a Go workspace", () => {
  it("maps a go.work `replace` to the directory it names, as go.mod's does", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-gowork-"));
    try {
      const files: Record<string, string> = {
        "go.work": "go 1.21\nuse (\n\t./garage\n)\nreplace example.com/pitkit => ./pitkit\n",
        "garage/go.mod": "module example.com/garage\ngo 1.21\n",
        "pitkit/pit.go": "package pit\n",
      };
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const projects = await detectSubProjects(root);
      const packages = projects.flatMap((p) => (p.packages ?? []).map((k) => `${k.name}=>${k.root}`));
      expect(packages).toEqual(["example.com/pitkit=>pitkit"]);
      expect(projects.find((p) => p.root === "garage")?.packageName).toBe("example.com/garage");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("detectSubProjects — the sibling projects a build declares", () => {
  it("reads .NET ProjectReference, Gradle project() paths and type-safe accessors", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-refs-"));
    try {
      const files: Record<string, string> = {
        "Garage.Web/Garage.Web.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><ProjectReference Include="..\\Garage.Core\\Garage.Core.csproj" /><ProjectReference Include="$(Shared)\\X.csproj" /></ItemGroup></Project>',
        "Garage.Core/Garage.Core.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
        "Garage.Old/Garage.Old.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
        "league/settings.gradle": "include ':web', ':club-core', ':club-api'\n",
        "league/web/build.gradle": "dependencies {\n  implementation project(':club-core')\n  // implementation project(':club-api')\n  api(projects.clubApi)\n}\n",
        "league/club-core/build.gradle": "plugins { id 'java' }\n",
        "league/club-api/build.gradle": "plugins { id 'java' }\n",
      };
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const projects = await detectSubProjects(root);
      const refs = (root_: string) => projects.find((p) => p.root === root_)?.references?.map((r) => `${r.project}<-${r.file}`);
      expect(refs("Garage.Web")).toEqual([`${projects.find((p) => p.root === "Garage.Core")!.id}<-Garage.Web/Garage.Web.csproj`]);
      expect(refs("league/web")?.map((r) => r.split("<-")[0]).sort()).toEqual(
        ["league/club-api", "league/club-core"].map((r) => projects.find((p) => p.root === r)!.id).sort(),
      );
      expect(refs("Garage.Old")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
