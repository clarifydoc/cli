import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectExternalPackages,
  collectInstalledOwners,
  attachPackageUsage,
  deriveFrameworksFromPackages,
  mergeFrameworkDetections,
} from "./dependency-inventory.js";
import type {
  ExternalPackage,
  FileAnalysis,
  FrameworkDetection,
  Language,
  PackageEcosystem,
} from "../types/analysis.js";

// ─── Manifest parsing + categorisation (real disk entry point) ─────────────

describe("collectExternalPackages — manifest parsing", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-deps-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { react: "^18.2.0", axios: "1.6.0", lodash: "^4.17.21", "@aws-sdk/client-s3": "^3.0.0" },
      devDependencies: { vitest: "^1.0.0", eslint: "^8.0.0", "@types/express": "^4.17.0" },
      peerDependencies: { "react-dom": "^18.0.0" },
      optionalDependencies: { fsevents: "^2.3.0" },
    }));
    await writeFile(join(dir, "go.mod"), [
      "module example.com/app",
      "go 1.21",
      "require (",
      "\tgithub.com/gin-gonic/gin v1.9.1",
      "\tgorm.io/gorm v1.25.0 // indirect",
      ")",
      "require github.com/lib/pq v1.10.9",
    ].join("\n"));
    await writeFile(join(dir, "Cargo.toml"), [
      "[dependencies]",
      'serde = { version = "1.0", features = ["derive"] }',
      'axum = "0.7"',
      "[dev-dependencies]",
      'pretty_assertions = "1.4"',
      "[dependencies.diesel]",
      'version = "2.1"',
    ].join("\n"));
    await writeFile(join(dir, "composer.json"), JSON.stringify({
      require: { php: ">=8.1", "ext-gd": "*", "laravel/framework": "^10.0", "guzzlehttp/guzzle": "^7.5" },
      "require-dev": { "phpunit/phpunit": "^10.0" },
    }));
    await writeFile(join(dir, "pom.xml"), [
      "<project><properties><league.annotations.version>1.6.8</league.annotations.version></properties>",
      "<!-- pin each API: <dependency><groupId>com.example.league</groupId><artifactId>{club}-api</artifactId></dependency> -->",
      "<dependencyManagement><dependencies><dependency><groupId>com.example.league</groupId><artifactId>league-bom</artifactId><version>2</version></dependency></dependencies></dependencyManagement>",
      "<dependencies>",
      "<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.1.0</version></dependency>",
      "<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.0</version><scope>test</scope></dependency>",
      "<dependency><groupId>com.example.league</groupId><artifactId>league-annotations</artifactId><version>${league.annotations.version}</version></dependency>",
      "</dependencies>",
      "<build><plugins><plugin><artifactId>dockerfile-maven-plugin</artifactId><dependencies><dependency><groupId>com.example.garage</groupId><artifactId>garage-socket</artifactId><version>0.38</version></dependency></dependencies></plugin></plugins></build>",
      "</project>",
    ].join("\n"));
    await writeFile(join(dir, "pubspec.yaml"), [
      "name: app",
      "dependencies:",
      "  flutter:",
      "    sdk: flutter",
      "  dio: ^5.3.0",
      "dev_dependencies:",
      "  flutter_test:",
      "    sdk: flutter",
      "  build_runner: ^2.4.0",
    ].join("\n"));
    await writeFile(join(dir, "Gemfile"), [
      'gem "rails", "~> 7.0"',
      'gem "pg"',
      'gem "puma", ">= 5.0", "< 7"',
      'gem "redis", require: false',
      'gem "nokogiri"',
      'gem "devise", github: "heartcombo/devise", branch: "4-stable"',
      "group :development, :test do",
      '  gem "rspec-rails"',
      "end",
    ].join("\n"));
    await writeFile(join(dir, "Gemfile.lock"), [
      "GIT",
      "  remote: https://github.com/heartcombo/devise.git",
      "  revision: 0123456789abcdef",
      "  branch: 4-stable",
      "  specs:",
      "    devise (4.9.3)",
      "",
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    nio4r (2.7.0)",
      "    nokogiri (1.15.4-x86_64-linux)",
      "    pg (1.5.4)",
      "    puma (6.4.0)",
      "    rails (7.0.8)",
      "      nio4r (~> 2.0)",
      "    redis (5.0.7)",
      "    rspec-rails (6.1.0)",
      "",
      "PLATFORMS",
      "  x86_64-linux",
      "",
      "DEPENDENCIES",
      "  pg",
      "  rails (~> 7.0)",
      "",
      "BUNDLED WITH",
      "   2.4.10",
    ].join("\n"));
    await writeFile(join(dir, "requirements.txt"), [
      "# top comment",
      "Django==4.2.0",
      "requests>=2.31",
      "-r other.txt",
    ].join("\n"));
    // NuGet via a nested .csproj (exercises the glob path).
    await mkdir(join(dir, "Api"), { recursive: true });
    await writeFile(join(dir, "Api", "Api.csproj"), [
      "<Project>",
      '  <ItemGroup>',
      '    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />',
      '    <PackageReference Include="Serilog"><Version>3.1.0</Version></PackageReference>',
      '    <PackageReference Include="MediatR" />',
      "  </ItemGroup>",
      "</Project>",
    ].join("\n"));
    // Central Package Management: the version-less reference's version lives here.
    await writeFile(join(dir, "Directory.Packages.props"), [
      "<Project>",
      '  <ItemGroup>',
      '    <PackageVersion Include="MediatR" Version="12.1.1" />',
      "  </ItemGroup>",
      "</Project>",
    ].join("\n"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses every ecosystem with name/version/scope/ecosystem", async () => {
    const pkgs = await collectExternalPackages(dir, []);
    const find = (eco: PackageEcosystem, name: string) =>
      pkgs.find((p) => p.ecosystem === eco && p.name === name);

    // npm scopes + version
    expect(find("npm", "react")).toMatchObject({ version: "^18.2.0", scope: "prod" });
    expect(find("npm", "vitest")?.scope).toBe("dev");
    expect(find("npm", "react-dom")?.scope).toBe("peer");
    expect(find("npm", "fsevents")?.scope).toBe("optional");

    // go: block + single + indirect (still listed)
    expect(find("go", "github.com/gin-gonic/gin")?.version).toBe("v1.9.1");
    expect(find("go", "gorm.io/gorm")).toBeTruthy();
    expect(find("go", "github.com/lib/pq")).toBeTruthy();

    // cargo: object-version, string-version, table form, dev scope
    expect(find("cargo", "serde")?.version).toBe("1.0");
    expect(find("cargo", "axum")?.version).toBe("0.7");
    expect(find("cargo", "diesel")?.version).toBe("2.1");
    expect(find("cargo", "pretty_assertions")?.scope).toBe("dev");

    // composer: platform reqs skipped, vendor/pkg kept
    expect(find("composer", "php")).toBeUndefined();
    expect(find("composer", "ext-gd")).toBeUndefined();
    expect(find("composer", "laravel/framework")?.scope).toBe("prod");
    expect(find("composer", "phpunit/phpunit")?.scope).toBe("dev");

    // maven: group:artifact name, test scope → dev
    expect(find("maven", "org.springframework.boot:spring-boot-starter-web")?.version).toBe("3.1.0");
    expect(find("maven", "org.junit.jupiter:junit-jupiter")?.scope).toBe("dev");
    // The POM's own properties fill a version; comments, managed versions and plugin dependencies are no dependency.
    expect(find("maven", "com.example.league:league-annotations")?.version).toBe("1.6.8");
    expect(pkgs.filter((p) => p.ecosystem === "maven").map((p) => p.name).sort()).toEqual([
      "com.example.league:league-annotations",
      "org.junit.jupiter:junit-jupiter",
      "org.springframework.boot:spring-boot-starter-web",
    ]);

    // pub: sdk pseudo-version → null, dev_dependencies
    expect(find("pub", "flutter")).toMatchObject({ version: null, scope: "prod" });
    expect(find("pub", "dio")?.version).toBe("^5.3.0");
    expect(find("pub", "build_runner")?.scope).toBe("dev");

    // rubygems: inline constraint stays authoritative over the lock
    expect(find("rubygems", "rails")?.version).toBe("~> 7.0");
    // multi-constraint positional args are all captured
    expect(find("rubygems", "puma")?.version).toBe(">= 5.0, < 7");
    // no inline constraint → exact version backfilled from Gemfile.lock
    expect(find("rubygems", "pg")?.version).toBe("1.5.4");
    expect(find("rubygems", "rspec-rails")).toMatchObject({ version: "6.1.0", scope: "dev" });
    // keyword-arg values (require:, branch:) are not constraints; GIT-section specs backfill too
    expect(find("rubygems", "redis")?.version).toBe("5.0.7");
    expect(find("rubygems", "devise")?.version).toBe("4.9.3");
    // platform suffix stripped off the locked version
    expect(find("rubygems", "nokogiri")?.version).toBe("1.15.4");
    // the lock never introduces packages (nio4r is transitive-only)
    expect(find("rubygems", "nio4r")).toBeUndefined();

    // pypi requirements: comment + flag lines skipped
    expect(find("pypi", "Django")?.version).toBe("==4.2.0");
    expect(find("pypi", "requests")).toBeTruthy();

    // nuget via nested csproj: attr + child version
    expect(find("nuget", "Microsoft.EntityFrameworkCore")?.version).toBe("8.0.0");
    expect(find("nuget", "Serilog")?.version).toBe("3.1.0");
    // nuget central package management
    expect(find("nuget", "MediatR")?.version).toBe("12.1.1");
  });

  it("categorises packages and flags frameworks", async () => {
    const pkgs = await collectExternalPackages(dir, []);
    const cat = (name: string) => pkgs.find((p) => p.name === name)?.category;

    expect(cat("react")).toBe("frontend");
    expect(cat("axios")).toBe("http");
    expect(cat("vitest")).toBe("testing");
    expect(cat("eslint")).toBe("lint");
    expect(cat("github.com/gin-gonic/gin")).toBe("framework");
    expect(cat("serde")).toBe("serialization");
    expect(cat("diesel")).toBe("orm");
    expect(cat("Microsoft.EntityFrameworkCore")).toBe("orm");
    expect(cat("Serilog")).toBe("logging");
    expect(cat("guzzlehttp/guzzle")).toBe("http");
    expect(cat("flutter")).toBe("frontend");
    // @types/* are stubs, never the framework they shadow
    expect(cat("@types/express")).toBe("types");
    expect(cat("lodash")).toBe("util");
    // family patterns: Spring Boot starter (Maven coord) + scoped cloud SDK
    expect(cat("org.springframework.boot:spring-boot-starter-web")).toBe("framework");
    expect(cat("@aws-sdk/client-s3")).toBe("cloud");
    // a genuinely-unrecognised package stays "other"
    expect(cat("fsevents")).toBe("other");
  });
});

// ─── Extended ecosystems (Swift / C++ / Scala / Perl / Lua / Pipfile) ───────

describe("collectExternalPackages — extended ecosystems", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-deps2-"));
    await writeFile(join(dir, "Package.swift"), [
      "// swift-tools-version:5.7",
      "import PackageDescription",
      'let package = Package(name: "App", dependencies: [',
      '  .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),',
      '  .package(url: "https://github.com/Alamofire/Alamofire.git", .upToNextMajor(from: "5.6.0")),',
      "])",
    ].join("\n"));
    await writeFile(join(dir, "Podfile"), [
      "platform :ios, '15.0'",
      "target 'App' do",
      "  pod 'RxSwift', '~> 6.5'",
      "  pod 'SnapKit'",
      "end",
    ].join("\n"));
    await writeFile(join(dir, "vcpkg.json"), JSON.stringify({
      dependencies: ["fmt", "boost", { name: "grpc", "version>=": "1.50" }],
    }));
    await writeFile(join(dir, "conanfile.txt"), [
      "[requires]", "spdlog/1.11.0", "[tool_requires]", "cmake/3.25.0",
    ].join("\n"));
    await writeFile(join(dir, "build.sbt"), [
      'libraryDependencies += "com.typesafe.akka" %% "akka-actor" % "2.6.20"',
      'libraryDependencies += "org.scalatest" %% "scalatest" % "3.2.15" % Test',
    ].join("\n"));
    await writeFile(join(dir, "cpanfile"), [
      "requires 'Mojolicious', '9.0';", "requires 'DBI';",
    ].join("\n"));
    await writeFile(join(dir, "app-1.0-1.rockspec"), [
      "package = 'app'", "dependencies = {", '  "lua >= 5.1",', '  "lapis",', '  "luasocket >= 3.0"', "}",
    ].join("\n"));
    await writeFile(join(dir, "Pipfile"), [
      "[packages]", 'flask = "*"', 'requests = ">=2.31"', "[dev-packages]", 'pytest = "*"',
    ].join("\n"));
    await writeFile(join(dir, "mix.exs"), [
      "defmodule App.MixProject do",
      "  defp deps do",
      "    [",
      '      {:phoenix, "~> 1.7"},',
      '      {:ecto_sql, "~> 3.10"},',
      '      {:credo, "~> 1.7", only: [:dev, :test]},',
      "      {:ok, result} = something()",
      "    ]",
      "  end",
      "end",
    ].join("\n"));
    await writeFile(join(dir, "rebar.config"), [
      "{erl_opts, [debug_info]}.",
      "{deps, [",
      '  {cowboy, "2.10.0"},',
      '  {jsx, "3.1.0"}',
      "]}.",
    ].join("\n"));
    await writeFile(join(dir, "app.cabal"), [
      "library",
      "  build-depends:  base >=4.7 && <5",
      "                , aeson",
      "                , servant-server",
      "  hs-source-dirs: src",
    ].join("\n"));
    await writeFile(join(dir, "deps.edn"), [
      "{:deps {org.clojure/clojure {:mvn/version \"1.11.1\"}",
      "        compojure/compojure {:mvn/version \"1.7.0\"}",
      "        cheshire/cheshire {:mvn/version \"5.11.0\"}}}",
    ].join("\n"));
  });

  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("parses SwiftPM/CocoaPods/vcpkg/Conan/sbt/cpan/luarocks/Pipfile + classifies", async () => {
    const pkgs = await collectExternalPackages(dir, []);
    const f = (eco: PackageEcosystem, name: string) =>
      pkgs.find((p) => p.ecosystem === eco && p.name === name);

    expect(f("swiftpm", "vapor")).toMatchObject({ version: "4.0.0", category: "framework" });
    expect(f("swiftpm", "Alamofire")?.category).toBe("http");
    expect(f("cocoapods", "RxSwift")).toMatchObject({ version: "~> 6.5", category: "state" });
    expect(f("cocoapods", "SnapKit")?.category).toBe("ui");
    expect(f("vcpkg", "fmt")?.category).toBe("util");
    expect(f("vcpkg", "grpc")).toMatchObject({ version: "1.50", category: "grpc" });
    expect(f("conan", "spdlog")).toMatchObject({ version: "1.11.0", category: "logging" });
    expect(f("conan", "cmake")?.scope).toBe("dev");
    // sbt resolves Maven coords; akka caught via the scala family pattern
    expect(f("maven", "com.typesafe.akka:akka-actor")?.category).toBe("framework");
    expect(f("maven", "org.scalatest:scalatest")?.scope).toBe("dev");
    expect(f("cpan", "Mojolicious")).toMatchObject({ version: "9.0", category: "framework" });
    expect(f("cpan", "DBI")?.category).toBe("database");
    expect(f("luarocks", "lapis")?.category).toBe("framework");
    expect(f("luarocks", "lua")).toBeUndefined(); // the runtime itself is skipped
    expect(f("pypi", "flask")?.category).toBe("framework");
    expect(f("pypi", "pytest")?.scope).toBe("dev");
    // Hex (mix.exs): version, category, dev scope, and code-tuple rejection
    expect(f("hex", "phoenix")).toMatchObject({ version: "~> 1.7", category: "framework" });
    expect(f("hex", "ecto_sql")?.category).toBe("orm");
    expect(f("hex", "credo")?.scope).toBe("dev");
    expect(f("hex", "ok")).toBeUndefined(); // `{:ok, result}` is not a dependency tuple
    // Hex via rebar.config (Erlang)
    expect(f("hex", "cowboy")).toMatchObject({ version: "2.10.0", category: "framework" });
    expect(f("hex", "jsx")?.category).toBe("serialization");
    // Hackage via .cabal build-depends (comma-list with version constraints)
    expect(f("hackage", "aeson")?.category).toBe("serialization");
    expect(f("hackage", "servant-server")?.category).toBe("framework");
    expect(f("hackage", "base")).toBeTruthy();
    // Clojars via deps.edn :mvn/version coords
    expect(f("clojars", "org.clojure/clojure")?.version).toBe("1.11.1");
    expect(f("clojars", "compojure/compojure")?.category).toBe("framework"); // segment fallback → compojure
    expect(f("clojars", "cheshire/cheshire")?.category).toBe("serialization");
  });
});

// ─── Usage cross-check ─────────────────────────────────────────────────────

function fileWith(language: Language, sources: string[]): FileAnalysis {
  return {
    filePath: `f.${language}`,
    language,
    imports: sources.map((source, i) => ({
      source,
      specifiers: [],
      isDefault: false,
      isNamespace: false,
      isType: false,
      line: i + 1,
    })),
  } as unknown as FileAnalysis;
}

function pkg(eco: PackageEcosystem, name: string): ExternalPackage {
  return { name, version: null, ecosystem: eco, scope: "prod", category: "other", declaredIn: "m" };
}

describe("attachPackageUsage", () => {
  it("marks npm packages used/unused (reliable ecosystem asserts unused)", () => {
    const pkgs = [pkg("npm", "react"), pkg("npm", "@scope/ui"), pkg("npm", "lodash")];
    attachPackageUsage(pkgs, [
      fileWith("typescript", ["react", "react/jsx-runtime", "@scope/ui/button", "./local"]),
    ]);
    expect(pkgs[0]).toMatchObject({ used: true, usageCount: 2 }); // react + react/jsx-runtime
    expect(pkgs[1]).toMatchObject({ used: true, usageCount: 1 }); // scoped subpath
    expect(pkgs[2]).toMatchObject({ used: false, usageCount: 0 }); // declared but never imported
  });

  it("matches go modules by import-path prefix", () => {
    const pkgs = [pkg("go", "gorm.io/gorm"), pkg("go", "github.com/lib/pq")];
    attachPackageUsage(pkgs, [fileWith("go", ["gorm.io/gorm/clause", "fmt"])]);
    expect(pkgs[0].used).toBe(true);
    expect(pkgs[1]).toMatchObject({ used: false, usageCount: 0 });
  });

  it("normalises cargo - / _ when matching use statements", () => {
    const pkgs = [pkg("cargo", "pretty-assertions"), pkg("cargo", "serde")];
    attachPackageUsage(pkgs, [fileWith("rust", ["pretty_assertions::assert_eq", "crate::local"])]);
    expect(pkgs[0].used).toBe(true);
    expect(pkgs[1]).toMatchObject({ used: false, usageCount: 0 });
  });

  it("resolves dart package: imports", () => {
    const pkgs = [pkg("pub", "dio"), pkg("pub", "provider")];
    attachPackageUsage(pkgs, [fileWith("dart", ["package:dio/dio.dart", "dart:async"])]);
    expect(pkgs[0].used).toBe(true);
    expect(pkgs[1]).toMatchObject({ used: false, usageCount: 0 });
  });

  it("is positive-only for pypi (never asserts unused)", () => {
    const pkgs = [pkg("pypi", "django"), pkg("pypi", "flask")];
    attachPackageUsage(pkgs, [fileWith("python", ["django.db.models"])]);
    expect(pkgs[0].used).toBe(true);
    expect(pkgs[1].used).toBeUndefined(); // import name ≠ dist name is common → unknown, not unused
  });

  it("leaves maven usage unknown (namespace ≠ artifact)", () => {
    const pkgs = [pkg("maven", "org.springframework.boot:spring-boot-starter-web")];
    attachPackageUsage(pkgs, [fileWith("java", ["org.springframework.boot.SpringApplication"])]);
    expect(pkgs[0].used).toBeUndefined();
    expect(pkgs[0].usageCount).toBeUndefined();
  });

  it("matches nuget by namespace prefix (positive-only)", () => {
    const pkgs = [pkg("nuget", "Microsoft.EntityFrameworkCore"), pkg("nuget", "Serilog")];
    attachPackageUsage(pkgs, [fileWith("csharp", ["Microsoft.EntityFrameworkCore.Metadata"])]);
    expect(pkgs[0].used).toBe(true);
    expect(pkgs[1].used).toBeUndefined();
  });

  it("matches Swift / native / Lua / Perl imports (positive-only)", () => {
    const pkgs = [
      pkg("swiftpm", "Alamofire"),
      pkg("cocoapods", "SnapKit"),
      pkg("vcpkg", "fmt"),
      pkg("conan", "spdlog"),
      pkg("luarocks", "lapis"),
      pkg("cpan", "Mojolicious"),
      pkg("swiftpm", "Vapor"), // declared but never imported
    ];
    attachPackageUsage(pkgs, [
      fileWith("swift", ["Alamofire", "SnapKit", "Foundation"]),
      fileWith("cpp", ["fmt/format.h", "spdlog/spdlog.h", "vector"]),
      fileWith("lua", ["lapis.application"]),
      fileWith("perl", ["Mojolicious::Lite"]),
    ]);
    expect(pkgs[0].used).toBe(true); // Alamofire — swiftpm module
    expect(pkgs[1].used).toBe(true); // SnapKit — cocoapods module
    expect(pkgs[2].used).toBe(true); // fmt — vcpkg, #include first segment
    expect(pkgs[3].used).toBe(true); // spdlog — conan
    expect(pkgs[4].used).toBe(true); // lapis — luarocks require root
    expect(pkgs[5].used).toBe(true); // Mojolicious — cpan module prefix
    expect(pkgs[6].used).toBeUndefined(); // Vapor not imported → unknown, never false
  });

  it("resolves Composer usage via the PSR-4 autoload map", () => {
    const pkgs = [pkg("composer", "guzzlehttp/guzzle"), pkg("composer", "monolog/monolog")];
    const composerAutoload = new Map([
      ["guzzlehttp", "guzzlehttp/guzzle"],
      ["monolog", "monolog/monolog"],
    ]);
    attachPackageUsage(
      pkgs,
      [fileWith("php", ["GuzzleHttp\\Client", "App\\Domain\\Car"])],
      { installedOwners: new Map([["composer", composerAutoload]]) },
    );
    expect(pkgs[0].used).toBe(true); // GuzzleHttp\Client → guzzlehttp/guzzle
    expect(pkgs[1].used).toBeUndefined(); // declared, never imported → unknown
  });

  it("leaves Composer usage unknown when no autoload map is available", () => {
    const pkgs = [pkg("composer", "guzzlehttp/guzzle")];
    attachPackageUsage(pkgs, [fileWith("php", ["GuzzleHttp\\Client"])]);
    expect(pkgs[0].used).toBeUndefined();
  });
});

describe("collectInstalledOwners", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-owners-"));
    // Composer 2 shape at the root; Composer 1 (a bare array) in a sub-project
    // that also installs guzzle — the root's entry wins.
    await mkdir(join(dir, "vendor", "composer"), { recursive: true });
    await writeFile(join(dir, "vendor", "composer", "installed.json"), JSON.stringify({
      packages: [
        { name: "guzzlehttp/guzzle", autoload: { "psr-4": { "GuzzleHttp\\": "src/" } } },
        { name: "Monolog/Monolog", autoload: { "psr-0": { "Monolog\\Handler\\": "src/" } } },
      ],
    }));
    await mkdir(join(dir, "api", "vendor", "composer"), { recursive: true });
    await writeFile(join(dir, "api", "vendor", "composer", "installed.json"), JSON.stringify([
      { name: "other/guzzle-fork", autoload: { "psr-4": { "GuzzleHttp\\": "src/" } } },
      { name: "slim/slim", autoload: { "psr-4": { "Slim\\": "Slim" } } },
    ]));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps each installed namespace to its package, the first root winning", async () => {
    const owners = await collectInstalledOwners(dir, ["api"]);
    expect([...owners.keys()]).toEqual(["composer"]);
    expect(Object.fromEntries(owners.get("composer")!)).toEqual({
      guzzlehttp: "guzzlehttp/guzzle",
      "monolog\\handler": "monolog/monolog",
      slim: "slim/slim",
    });
  });

  it("is empty when nothing is installed", async () => {
    expect((await collectInstalledOwners(join(dir, "api", "vendor"), [])).size).toBe(0);
  });
});

// ─── Framework derivation + merge ──────────────────────────────────────────

describe("deriveFrameworksFromPackages", () => {
  it("derives framework detections with confidence by scope/usage", () => {
    const react = { ...pkg("npm", "react"), category: "frontend" as const, used: true };
    const jestDev: ExternalPackage = { ...pkg("npm", "next"), scope: "dev" };
    const fws = deriveFrameworksFromPackages([react, jestDev]);
    const byId = Object.fromEntries(fws.map((f) => [f.id, f]));
    expect(byId.react).toMatchObject({ name: "React", confidence: "high" });
    expect(byId.nextjs?.confidence).toBe("medium"); // dev-only ⇒ weaker signal
  });

  it("does not emit detections for non-framework packages", () => {
    expect(deriveFrameworksFromPackages([pkg("npm", "lodash")])).toEqual([]);
  });

  it("dedupes a framework declared in multiple ecosystems, keeping the strongest", () => {
    const weak: ExternalPackage = { ...pkg("npm", "react"), scope: "dev" };
    const strong: ExternalPackage = { ...pkg("npm", "react-dom"), used: true };
    const fws = deriveFrameworksFromPackages([weak, strong]);
    expect(fws.filter((f) => f.id === "react")).toHaveLength(1);
    expect(fws.find((f) => f.id === "react")?.confidence).toBe("high");
  });
});

describe("mergeFrameworkDetections", () => {
  const rule = (id: string, name: string): FrameworkDetection => ({
    id, name, confidence: "high", detectedVia: "package.json dependency",
  });
  const derived = (id: string, name: string): FrameworkDetection => ({
    id, name, confidence: "medium", detectedVia: "npm dependency",
  });

  it("keeps the rule-based entry on id collision and appends new ones", () => {
    const merged = mergeFrameworkDetections(
      [rule("react", "React")],
      [derived("react", "React"), derived("astro", "Astro")],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((f) => f.id === "react")?.detectedVia).toBe("package.json dependency");
    expect(merged.find((f) => f.id === "astro")?.detectedVia).toBe("npm dependency");
  });
});

describe("collectExternalPackages — vendored git submodules", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-gitmod-"));
    await writeFile(join(dir, ".gitmodules"), [
      '[submodule "lib-externes/ZXing.Delphi"]',
      "\tpath = lib-externes/ZXing.Delphi",
      "\turl = https://github.com/Spelt/ZXing.Delphi.git",
      '[submodule "lib-externes/librairies"]',
      "\tpath = lib-externes/librairies",
      "\turl = https://github.com/DeveloppeurPascal/librairies.git",
      '[submodule "pathless"]',
      "\turl = git@github.com:acme/tools.git",
    ].join("\n"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("declares each submodule as a git-ecosystem dependency named by its repo", async () => {
    const pkgs = await collectExternalPackages(dir, []);
    const git = pkgs.filter((p) => p.ecosystem === "git");
    expect(git.map((p) => p.name).sort()).toEqual(["ZXing.Delphi", "librairies", "tools"]);
    expect(git[0]!.declaredIn).toBe(".gitmodules");
    expect(git[0]!.version).toBeNull();
  });
});

describe("collectExternalPackages — one package, several manifests", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-skew-"));
    for (const [sub, deps] of [["web", { axios: "^0.21.1", react: "^18.2.0" }], ["admin", { axios: "^1.6.0", react: "^18.2.0" }]] as const) {
      await mkdir(join(dir, sub));
      await writeFile(join(dir, sub, "package.json"), JSON.stringify({ name: sub, dependencies: deps }));
    }
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("keeps each declaration and flags versions that disagree", async () => {
    const pkgs = await collectExternalPackages(dir, ["admin", "web"]);
    const axios = pkgs.find((p) => p.name === "axios")!;
    expect(axios.versionSkew).toBe(true);
    expect(axios.declarations?.map((d) => [d.declaredIn, d.version])).toEqual([
      ["admin/package.json", "^1.6.0"],
      ["web/package.json", "^0.21.1"],
    ]);
    // The same version in both: listed where it is declared, no skew.
    const react = pkgs.find((p) => p.name === "react")!;
    expect(react.versionSkew).toBeUndefined();
    expect(react.declarations?.map((d) => d.declaredIn)).toEqual(["admin/package.json", "web/package.json"]);
  });
});

describe("npm tooling is used without being imported", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-npm-tools-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({
      scripts: { build: "tsc -p . && vite build", lint: "npx eslint src", test: "cross-env CI=1 vitest run", fmt: "prettier --write ." },
      dependencies: { react: "^18.0.0" },
      devDependencies: {
        typescript: "^5", vite: "^5", eslint: "^9", vitest: "^2", prettier: "^3", "cross-env": "^7",
        "eslint-plugin-react": "^7", "ts-loader": "^9", "@babel/preset-env": "^7",
        "@types/react": "^18", "@types/node": "^20", "left-pad": "^1",
      },
    }));
    await writeFile(join(dir, ".eslintrc.json"), JSON.stringify({ extends: ["plugin:react/recommended"], env: { node: true } }));
    await writeFile(join(dir, "webpack.config.js"), "module.exports = { module: { rules: [{ test: /\\.tsx?$/, loader: 'ts-loader' }] } };");
    await writeFile(join(dir, ".babelrc"), JSON.stringify({ presets: ["@babel/preset-env"] }));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it("marks script commands, config mentions and imported types as used", async () => {
    const pkgs = await collectExternalPackages(dir, []);
    attachPackageUsage(pkgs, [{ language: "typescript", imports: [{ source: "react" }] } as unknown as FileAnalysis]);
    const used = Object.fromEntries(pkgs.map((p) => [p.name, p.used]));
    expect(used).toMatchObject({
      typescript: true, vite: true, eslint: true, vitest: true, prettier: true, "cross-env": true,
      "eslint-plugin-react": true, "ts-loader": true, "@babel/preset-env": true,
      "@types/react": true, "@types/node": true, "left-pad": false,
    });
    expect(pkgs.find((p) => p.name === "@types/react")!.usedBy).toEqual(["types"]);
    expect(pkgs.find((p) => p.name === "typescript")!.usedBy).toEqual(["script"]);
  });
});
