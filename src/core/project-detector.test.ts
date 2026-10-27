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
