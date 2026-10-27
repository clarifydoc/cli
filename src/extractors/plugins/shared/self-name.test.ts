import { describe, it, expect } from "vitest";
import type { SelfNameContext } from "../../../types/language-plugin.js";
import { cargoPackageManager } from "../rust/package-manifests.js";
import { goPackageManager } from "../go/package-manifests.js";
import { npmPackageManager } from "../javascript/package-manifests.js";
import { gradleSelfName, pomSelfName } from "../java-kotlin/package-manifests.js";
import { projectFileSelfName } from "../csharp/package-manifests.js";

/** A manifest named `fileName` in directory `dirName`, with `siblings` beside it and `above` in the directories over it (nearest first). */
function at(fileName: string, dirName: string | null, siblings: Record<string, string> = {}, above: Record<string, string[]> = {}): SelfNameContext {
  return {
    fileName,
    dirName,
    readSibling: async (name) => siblings[name] ?? null,
    readAncestors: async (name) => above[name] ?? [],
  };
}

/** `PackageManifestSpec.selfName`: the package a manifest declares for itself. */
describe("manifest self names", () => {
  it("reads Cargo [package] name, not a workspace-only manifest", () => {
    const cargo = cargoPackageManager.manifests[0]!;
    expect(cargo.selfName!(`[package]\nname = "league_db_views_site"\nversion.workspace = true\n\n[dependencies]\nname = "x"`, at("Cargo.toml", "site"))).toBe("league_db_views_site");
    expect(cargo.selfName!(`[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nname = "nope"`, at("Cargo.toml", null))).toBeNull();
  });
  it("reads go.mod module and package.json name", () => {
    expect(goPackageManager.manifests[0]!.selfName!(`module code.example.com/league\n\ngo 1.22\n`, at("go.mod", null))).toBe("code.example.com/league");
    expect(npmPackageManager.manifests[0]!.selfName!(`{ "name": "@acme/ui", "version": "1.0.0" }`, at("package.json", "ui"))).toBe("@acme/ui");
    expect(npmPackageManager.manifests[0]!.selfName!(`{ "private": true }`, at("package.json", "ui"))).toBeNull();
  });

  it("reads a POM's own coordinates, the group inherited from its parent", () => {
    const pom = (body: string) => `<project>\n  <modelVersion>4.0.0</modelVersion>\n${body}\n</project>`;
    // The parent's and each dependency's ids are other projects'.
    expect(pomSelfName(pom(`  <parent>\n    <groupId>com.example.league</groupId>\n    <artifactId>league</artifactId>\n    <version>1.0.0</version>\n  </parent>\n  <artifactId>club-api</artifactId>\n  <dependencies>\n    <dependency><groupId>javax.ws.rs</groupId><artifactId>javax.ws.rs-api</artifactId></dependency>\n  </dependencies>`))).toBe("com.example.league:club-api");
    expect(pomSelfName(pom(`  <groupId>com.example.garage</groupId>\n  <!-- <artifactId>old</artifactId> -->\n  <artifactId>garage-${"$"}{flavour}</artifactId>\n  <properties><flavour>client</flavour></properties>`))).toBe("com.example.garage:garage-client");
    expect(pomSelfName(pom(`  <artifactId>${"$"}{unknown}</artifactId>\n  <groupId>com.example</groupId>`))).toBeNull();
    expect(pomSelfName(pom(`  <artifactId>orphan</artifactId>`))).toBeNull();
  });

  it("reads a Gradle build's group and project name, from the build, the settings, an enclosing build or gradle.properties", async () => {
    // Its own group; the name is the directory's below the analysis root.
    expect(await gradleSelfName(`plugins { id 'java-library' }\ngroup = 'com.example.league'\ndependencies {\n  implementation(\n    group = "org.slf4j", name = "slf4j-api")\n}\n`, at("build.gradle", "club-api"))).toBe("com.example.league:club-api");
    // At the analysis root the directory is the checkout's: only rootProject.name names it.
    expect(await gradleSelfName(`group = "com.example.garage"\n`, at("build.gradle.kts", null))).toBeNull();
    expect(await gradleSelfName(`group = "com.example.garage"\n`, at("build.gradle.kts", null, { "settings.gradle.kts": `rootProject.name = "garage"\ninclude("cars")\n` }))).toBe("com.example.garage:garage");
    // A group the root build sets for every project, and the published artifact id.
    expect(await gradleSelfName(`publishing {\n  publications {\n    create<MavenPublication>("lib") { artifactId = "cars-client" }\n  }\n}\n`, at("build.gradle.kts", "cars", {}, { "build.gradle.kts": [`subprojects {\n  group = "com.example.garage"\n}\n`] }))).toBe("com.example.garage:cars-client");
    expect(await gradleSelfName(`base { archivesName.set("match-report") }\n`, at("build.gradle.kts", "report", {}, { "gradle.properties": ["version=1.0\ngroup=com.example.league\n"] }))).toBe("com.example.league:match-report");
    // A subprojects block is the children's, not the build's own.
    expect(await gradleSelfName(`subprojects {\n  group = "com.example.league"\n}\n`, at("build.gradle", "league"))).toBeNull();
  });

  it("reads a .NET project's package id, assembly name or file name — never a test project's", () => {
    expect(projectFileSelfName(`<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><PackageId>Garage.Client</PackageId><AssemblyName>Garage</AssemblyName></PropertyGroup>\n</Project>`, at("Garage.csproj", "Garage"))).toBe("Garage.Client");
    expect(projectFileSelfName(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><AssemblyName>League.Stats</AssemblyName></PropertyGroup></Project>`, at("Stats.fsproj", "Stats"))).toBe("League.Stats");
    expect(projectFileSelfName(`<Project Sdk="Microsoft.NET.Sdk" />`, at("Cars.Api.csproj", "cars"))).toBe("Cars.Api");
    expect(projectFileSelfName(`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup></Project>`, at("Cars.Tests.csproj", "tests"))).toBeNull();
    expect(projectFileSelfName(`<Project><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>`, at("Tools.csproj", "tools"))).toBeNull();
    expect(projectFileSelfName(`<Project><ItemGroup><PackageVersion Include="Polly" Version="8.0.0" /></ItemGroup></Project>`, at("Directory.Packages.props", null))).toBeNull();
  });
});
