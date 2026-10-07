import { describe, it, expect } from "vitest";
import type { LanguagePluginManifest } from "../types/language-plugin.js";
import { claimTable, EXTENSION_TO_LANGUAGE, PACKAGE_MANAGERS, packageEcosystemsFor, packageMatchingFor } from "./registry.js";
import { extensionFamily } from "./plugins/shared/path-utils.js";

const manifest = (language: string, extensions: string[]): LanguagePluginManifest =>
  ({ language, parsing: "regex", extensions }) as unknown as LanguagePluginManifest;

describe("claimTable", () => {
  it("maps each lowercased key to its one owner", () => {
    const table = claimTable([manifest("perl", [".pl", ".PM"]), manifest("ruby", [".rb"])], (m) => m.extensions, "Extension");
    expect(Object.fromEntries(table)).toEqual({ ".pl": "perl", ".pm": "perl", ".rb": "ruby" });
  });

  it("throws on a second claim, whatever its casing", () => {
    expect(() =>
      claimTable([manifest("perl", [".pl"]), manifest("raku", [".PL"])], (m) => m.extensions, "Extension"),
    ).toThrow(/Extension "\.PL" claimed by both perl and raku/);
  });
});

describe("registered extensions", () => {
  it("route the script and kernel dialects to their host plugins", () => {
    expect(EXTENSION_TO_LANGUAGE[".csx"]).toBe("csharp");
    expect(EXTENSION_TO_LANGUAGE[".vbs"]).toBe("vb");
    expect(EXTENSION_TO_LANGUAGE[".cu"]).toBe("cpp");
    expect(EXTENSION_TO_LANGUAGE[".cuh"]).toBe("cpp");
    expect(EXTENSION_TO_LANGUAGE[".sc"]).toBe("scala");
    for (const ext of [".t", ".psgi", ".cgi"]) expect(EXTENSION_TO_LANGUAGE[ext]).toBe("perl");
  });
});

describe("package managers", () => {
  it("say which ecosystems each language imports from", () => {
    expect(packageEcosystemsFor("objc")).toEqual(["swiftpm", "cocoapods"]);
    expect(packageEcosystemsFor("vb")).toEqual(["nuget"]);
    expect(packageEcosystemsFor("erlang")).toEqual(["hex"]);
    expect(packageEcosystemsFor("clojure")).toEqual([]);
  });

  it("let several plugins declare one ecosystem's manifests, with one owner of its import matching", () => {
    const hexFiles = PACKAGE_MANAGERS.filter((m) => m.ecosystem === "hex").flatMap((m) => m.manifests.flatMap((s) => s.files));
    expect(hexFiles).toEqual(["mix.exs", "rebar.config"]);
    expect(packageMatchingFor("hex")?.importKey?.("Phoenix.Controller")).toBe("phoenix");
    // Maven: pom.xml (Java) + build.sbt (Scala), and no import names an artifact.
    expect(PACKAGE_MANAGERS.filter((m) => m.ecosystem === "maven").flatMap((m) => m.manifests.flatMap((s) => s.files))).toEqual(["pom.xml", "build.sbt"]);
    expect(packageMatchingFor("maven")).toBeUndefined();
  });
});

describe("extensionFamily", () => {
  it("comes from the manifests' family", () => {
    expect(extensionFamily("Scripts/report.csx")).toBe("dotnet");
    expect(extensionFamily("jobs/close.VBS")).toBe("dotnet");
    expect(extensionFamily("src/kernels.cuh")).toBe("cfam");
    expect(extensionFamily("include/util.hh")).toBe("cfam");
    expect(extensionFamily("build.sc")).toBe("jvm");
    expect(extensionFamily("app.vue")).toBe("script");
  });

  it("is null for a language with no family and for unclaimed extensions", () => {
    expect(extensionFamily("schema.prisma")).toBeNull();
    expect(extensionFamily("README.md")).toBeNull();
    expect(extensionFamily("Makefile")).toBeNull();
  });
});
