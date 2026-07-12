import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import fg from "fast-glob";
import type { FrameworkDetection } from "../types/analysis.js";
import type { ProjectInfo } from "../types/plugin.js";

interface FrameworkRule {
  id: string;
  name: string;
  check: (info: ProjectInfo) => boolean;
  detectedVia: string;
}

/**
 * Well-known relative paths whose existence identifies a vendored framework.
 * Checked with a cheap existsSync per candidate while building ProjectInfo.
 */
const MARKER_CANDIDATES = [
  "system/core/CodeIgniter.php", // CodeIgniter 2/3 vendored core
];

const FRAMEWORK_RULES: FrameworkRule[] = [
  // JavaScript/TypeScript frameworks
  {
    id: "react",
    name: "React",
    check: (info) => hasDep(info, "react"),
    detectedVia: "package.json dependency",
  },
  {
    id: "react-router",
    name: "React Router",
    check: (info) =>
      hasDep(info, "react-router-dom") || hasDep(info, "react-router"),
    detectedVia: "package.json dependency",
  },
  {
    id: "nextjs",
    name: "Next.js",
    check: (info) => hasDep(info, "next"),
    detectedVia: "package.json dependency",
  },
  {
    id: "vue",
    name: "Vue",
    check: (info) => hasDep(info, "vue"),
    detectedVia: "package.json dependency",
  },
  {
    id: "vue-router",
    name: "Vue Router",
    check: (info) => hasDep(info, "vue-router"),
    detectedVia: "package.json dependency",
  },
  {
    id: "angular",
    name: "Angular",
    check: (info) => hasDep(info, "@angular/core"),
    detectedVia: "package.json dependency",
  },
  {
    id: "svelte",
    name: "Svelte",
    check: (info) => hasDep(info, "svelte") || hasDep(info, "@sveltejs/kit"),
    detectedVia: "package.json dependency",
  },
  {
    id: "express",
    name: "Express",
    check: (info) => hasDep(info, "express"),
    detectedVia: "package.json dependency",
  },
  {
    id: "nestjs",
    name: "NestJS",
    check: (info) => hasDep(info, "@nestjs/core"),
    detectedVia: "package.json dependency",
  },
  {
    id: "fastify",
    name: "Fastify",
    check: (info) => hasDep(info, "fastify"),
    detectedVia: "package.json dependency",
  },
  {
    id: "quasar",
    name: "Quasar",
    check: (info) => hasDep(info, "quasar") || hasDep(info, "@quasar/app-vite") || hasDep(info, "@quasar/app-webpack"),
    detectedVia: "package.json dependency",
  },
  {
    id: "nuxt",
    name: "Nuxt",
    check: (info) => hasDep(info, "nuxt") || hasDep(info, "nuxt3") || hasDep(info, "nuxt-edge"),
    detectedVia: "package.json dependency",
  },
  // State management
  {
    id: "vuex",
    name: "Vuex",
    check: (info) => hasDep(info, "vuex"),
    detectedVia: "package.json dependency",
  },
  {
    id: "pinia",
    name: "Pinia",
    check: (info) => hasDep(info, "pinia"),
    detectedVia: "package.json dependency",
  },
  {
    id: "redux",
    name: "Redux",
    check: (info) => hasDep(info, "redux") || hasDep(info, "@reduxjs/toolkit") || hasDep(info, "react-redux"),
    detectedVia: "package.json dependency",
  },
  {
    id: "zustand",
    name: "Zustand",
    check: (info) => hasDep(info, "zustand"),
    detectedVia: "package.json dependency",
  },
  {
    id: "react-query",
    name: "React Query",
    check: (info) => hasDep(info, "@tanstack/react-query") || hasDep(info, "react-query"),
    detectedVia: "package.json dependency",
  },

  // C# frameworks
  {
    id: "aspnet",
    name: "ASP.NET",
    // A `.csproj` alone means "some .NET project" — NOT ASP.NET (it's just as
    // likely a desktop/Blazor/console/library project). Require a real server-web
    // signal: the Web SDK, the AspNetCore shared framework, or an MVC package.
    // (Blazor's `Microsoft.AspNetCore.Components.*` is deliberately NOT counted —
    // see the dedicated `blazor` rule below.)
    check: (info) =>
      hasCsprojSdk(info, "Microsoft.NET.Sdk.Web") ||
      hasCsprojFrameworkRef(info, "Microsoft.AspNetCore.App") ||
      hasCsprojPackage(info, "Microsoft.AspNetCore.Mvc") ||
      hasCsprojPackage(info, "Microsoft.AspNetCore.App"),
    detectedVia: ".csproj Web SDK / AspNetCore reference",
  },
  {
    id: "blazor",
    name: "Blazor",
    // `Microsoft.AspNetCore.Components[.Web|.WebView|.WebAssembly]` — covers
    // Blazor Server, WASM, and Hybrid (WebView). `hasCsprojPackage` is a prefix
    // match, so the base namespace catches every variant.
    check: (info) => hasCsprojPackage(info, "Microsoft.AspNetCore.Components"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "maui",
    name: ".NET MAUI",
    check: (info) => hasCsprojProp(info, "UseMaui") || hasCsprojPackage(info, "Microsoft.Maui"),
    detectedVia: ".csproj reference",
  },
  {
    id: "winui",
    name: "WinUI / Windows App SDK",
    check: (info) => hasCsprojPackage(info, "Microsoft.WindowsAppSDK"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "uno",
    name: "Uno Platform",
    check: (info) => hasCsprojPackage(info, "Uno.WinUI") || hasCsprojPackage(info, "Uno.UI"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "wpf",
    name: "WPF",
    check: (info) => hasCsprojProp(info, "UseWPF"),
    detectedVia: ".csproj <UseWPF>",
  },
  {
    id: "winforms",
    name: "Windows Forms",
    check: (info) => hasCsprojProp(info, "UseWindowsForms"),
    detectedVia: ".csproj <UseWindowsForms>",
  },
  {
    id: "avalonia",
    name: "Avalonia",
    check: (info) => hasCsprojPackage(info, "Avalonia"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "gtk",
    name: "GTK",
    check: (info) => hasCsprojPackage(info, "GtkSharp") || hasCsprojPackage(info, "GirCore.Gtk"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "mef",
    name: "MEF (Managed Extensibility Framework)",
    check: (info) =>
      hasCsprojPackage(info, "System.ComponentModel.Composition") ||
      hasCsprojPackage(info, "System.Composition"),
    detectedVia: ".csproj PackageReference",
  },

  // ─── ORM frameworks ─────────────────────────────────────────────────────
  // JavaScript/TypeScript ORMs
  {
    id: "prisma",
    name: "Prisma",
    check: (info) => hasDep(info, "prisma") || hasDep(info, "@prisma/client"),
    detectedVia: "package.json dependency",
  },
  {
    id: "typeorm",
    name: "TypeORM",
    check: (info) => hasDep(info, "typeorm"),
    detectedVia: "package.json dependency",
  },
  {
    id: "sequelize",
    name: "Sequelize",
    check: (info) => hasDep(info, "sequelize") || hasDep(info, "sequelize-typescript"),
    detectedVia: "package.json dependency",
  },
  {
    id: "drizzle",
    name: "Drizzle ORM",
    check: (info) => hasDep(info, "drizzle-orm"),
    detectedVia: "package.json dependency",
  },
  {
    id: "mikro-orm",
    name: "MikroORM",
    check: (info) => hasDep(info, "@mikro-orm/core"),
    detectedVia: "package.json dependency",
  },
  {
    id: "mongoose",
    name: "Mongoose",
    check: (info) => hasDep(info, "mongoose"),
    detectedVia: "package.json dependency",
  },
  {
    id: "knex",
    name: "Knex",
    check: (info) => hasDep(info, "knex"),
    detectedVia: "package.json dependency",
  },
  {
    id: "objection",
    name: "Objection.js",
    check: (info) => hasDep(info, "objection"),
    detectedVia: "package.json dependency",
  },
  // C# ORMs (PackageReference scanning of .csproj text)
  {
    id: "ef-core",
    name: "Entity Framework Core",
    check: (info) => hasCsprojPackage(info, "Microsoft.EntityFrameworkCore"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "ef6",
    name: "Entity Framework 6",
    check: (info) =>
      hasCsprojPackage(info, "EntityFramework") &&
      !hasCsprojPackage(info, "Microsoft.EntityFrameworkCore"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "dapper",
    name: "Dapper",
    check: (info) => hasCsprojPackage(info, "Dapper"),
    detectedVia: ".csproj PackageReference",
  },
  {
    id: "nhibernate",
    name: "NHibernate",
    check: (info) => hasCsprojPackage(info, "NHibernate"),
    detectedVia: ".csproj PackageReference",
  },
  // Python ORMs
  {
    id: "sqlalchemy",
    name: "SQLAlchemy",
    check: (info) => hasPythonDep(info, "sqlalchemy"),
    detectedVia: "Python manifest",
  },
  {
    id: "django-orm",
    name: "Django ORM",
    check: (info) => hasPythonDep(info, "django"),
    detectedVia: "Python manifest",
  },
  {
    id: "tortoise-orm",
    name: "Tortoise ORM",
    check: (info) => hasPythonDep(info, "tortoise"),
    detectedVia: "Python manifest",
  },
  {
    id: "peewee",
    name: "Peewee",
    check: (info) => hasPythonDep(info, "peewee"),
    detectedVia: "Python manifest",
  },
  // Java/Kotlin ORMs
  {
    id: "hibernate",
    name: "Hibernate",
    check: (info) => hasGradleDep(info, "hibernate") || hasMavenDep(info, "hibernate"),
    detectedVia: "build file dependency",
  },
  {
    id: "spring-data-jpa",
    name: "Spring Data JPA",
    check: (info) => hasGradleDep(info, "spring-data-jpa") || hasMavenDep(info, "spring-data-jpa") ||
                     hasGradleDep(info, "spring-boot-starter-data-jpa") || hasMavenDep(info, "spring-boot-starter-data-jpa"),
    detectedVia: "build file dependency",
  },
  {
    id: "mybatis",
    name: "MyBatis",
    check: (info) => hasGradleDep(info, "mybatis") || hasMavenDep(info, "mybatis"),
    detectedVia: "build file dependency",
  },
  {
    id: "jooq",
    name: "jOOQ",
    check: (info) => hasGradleDep(info, "jooq") || hasMavenDep(info, "jooq"),
    detectedVia: "build file dependency",
  },
  {
    id: "exposed",
    name: "Exposed",
    check: (info) => hasGradleDep(info, "org.jetbrains.exposed"),
    detectedVia: "build file dependency",
  },
  // Ruby ORMs
  {
    id: "active-record",
    name: "Active Record",
    check: (info) => hasGemfileDep(info, "activerecord") || hasGemfileDep(info, "rails"),
    detectedVia: "Gemfile dependency",
  },
  {
    id: "sequel",
    name: "Sequel",
    check: (info) => hasGemfileDep(info, "sequel"),
    detectedVia: "Gemfile dependency",
  },
  // PHP frameworks with no composer manifest — detected via vendored layout.
  // CodeIgniter 2/3 ships its framework as a checked-in `system/` tree beside
  // the `application/` dir; composer-era CI4 is covered by knownPackages.
  {
    id: "codeigniter",
    name: "CodeIgniter",
    check: (info) => info.markerFiles.includes("system/core/CodeIgniter.php"),
    detectedVia: "vendored system/core/CodeIgniter.php",
  },
  // PHP ORMs
  {
    id: "doctrine",
    name: "Doctrine ORM",
    check: (info) => hasComposerDep(info, "doctrine/orm") || hasComposerDep(info, "doctrine/dbal"),
    detectedVia: "composer.json dependency",
  },
  {
    id: "eloquent",
    name: "Eloquent",
    check: (info) => hasComposerDep(info, "illuminate/database") || hasComposerDep(info, "laravel/framework"),
    detectedVia: "composer.json dependency",
  },
  // Go ORMs
  {
    id: "gorm",
    name: "GORM",
    check: (info) => hasGoMod(info, "gorm.io/gorm"),
    detectedVia: "go.mod dependency",
  },
  {
    id: "sqlx",
    name: "sqlx",
    check: (info) => hasGoMod(info, "github.com/jmoiron/sqlx"),
    detectedVia: "go.mod dependency",
  },
  {
    id: "ent",
    name: "Ent",
    check: (info) => hasGoMod(info, "entgo.io/ent"),
    detectedVia: "go.mod dependency",
  },
  // Rust ORMs
  {
    id: "diesel",
    name: "Diesel",
    check: (info) => hasCargoDep(info, "diesel"),
    detectedVia: "Cargo.toml dependency",
  },
  {
    id: "sea-orm",
    name: "SeaORM",
    check: (info) => hasCargoDep(info, "sea-orm"),
    detectedVia: "Cargo.toml dependency",
  },
  {
    id: "rust-sqlx",
    name: "SQLx (Rust)",
    check: (info) => hasCargoDep(info, "sqlx") && !hasCargoDep(info, "sea-orm"),
    detectedVia: "Cargo.toml dependency",
  },
  // Qt (C++ desktop) — find_package(Qt5/Qt6 …) in the root CMakeLists, or
  // qmake project files alongside C++ sources.
  {
    id: "qt",
    name: "Qt",
    check: (info) =>
      (!!info.cmakeLists && /find_package\s*\(\s*Qt[456]?/i.test(info.cmakeLists)) ||
      info.fileExtensions.has(".qml") ||
      info.fileExtensions.has(".pro"),
    detectedVia: "CMakeLists find_package / .qml files",
  },
  {
    id: "qt-quick",
    name: "Qt Quick (QML)",
    check: (info) => info.fileExtensions.has(".qml"),
    detectedVia: ".qml files",
  },
  // Raw SQL — surfaced when *.sql / *.ddl files exist
  {
    id: "sql",
    name: "SQL",
    check: (info) => info.sqlFiles.length > 0,
    detectedVia: ".sql / .ddl files",
  },
  // Java web view tier — JSP pages exist
  {
    id: "jsp",
    name: "JSP",
    check: (info) => info.jspFiles.length > 0,
    detectedVia: ".jsp files",
  },
  // Spring Web Flow — flow definition XMLs (in-house wrappers pull the jar in
  // transitively, so the build file often never names it) or an explicit dep.
  {
    id: "spring-webflow",
    name: "Spring Web Flow",
    check: (info) =>
      info.webflowFiles.length > 0 ||
      hasMavenDep(info, "spring-webflow") ||
      hasGradleDep(info, "spring-webflow"),
    detectedVia: "webflow XML definitions / build dependency",
  },

  // Python frameworks
  {
    id: "fastapi",
    name: "FastAPI",
    check: (info) => hasPythonDep(info, "fastapi"),
    detectedVia: "Python manifest",
  },
  {
    id: "django",
    name: "Django",
    check: (info) => hasPythonDep(info, "django"),
    detectedVia: "Python manifest",
  },
  {
    id: "flask",
    name: "Flask",
    check: (info) => hasPythonDep(info, "flask"),
    detectedVia: "Python manifest",
  },

  // Delphi/Pascal frameworks
  {
    id: "vcl",
    name: "VCL",
    check: (info) => hasDelphiDep(info, "Vcl.Forms") || hasDelphiDep(info, "Vcl.Controls"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "fmx",
    name: "FireMonkey (FMX)",
    check: (info) => hasDelphiDep(info, "FMX.Forms") || hasDelphiDep(info, "FMX.Controls"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "datasnap",
    name: "DataSnap",
    check: (info) => hasDelphiDep(info, "Datasnap.DSServer") || hasDelphiDep(info, "Datasnap.DSHTTPWebBroker"),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "rad-server",
    name: "RAD Server",
    check: (info) => hasDelphiDep(info, "EMS.Services") || hasDelphiDep(info, "EMSHosting."),
    detectedVia: "Delphi uses clause",
  },
  {
    id: "delphi",
    name: "Delphi",
    check: (info) => info.dprojFiles.length > 0,
    detectedVia: ".dproj file",
  },
  {
    id: "lazarus",
    name: "Lazarus",
    check: (info) => info.lpiFiles.length > 0,
    detectedVia: ".lpi file",
  },

  // Java/Kotlin frameworks
  {
    id: "spring-boot",
    name: "Spring Boot",
    check: (info) => hasGradleDep(info, "spring-boot") || hasMavenDep(info, "spring-boot"),
    detectedVia: "build file dependency",
  },
  {
    id: "spring-web",
    name: "Spring Web",
    check: (info) => hasGradleDep(info, "spring-web") || hasMavenDep(info, "spring-web"),
    detectedVia: "build file dependency",
  },
  {
    id: "ktor",
    name: "Ktor",
    check: (info) => hasGradleDep(info, "ktor"),
    detectedVia: "build file dependency",
  },
  {
    id: "android",
    name: "Android",
    check: (info) => hasGradleDep(info, "com.android") || hasGradleDep(info, "android"),
    detectedVia: "build file dependency",
  },

  // Dart / Flutter frameworks
  {
    id: "flutter",
    name: "Flutter",
    check: (info) => hasPubspecDep(info, "flutter"),
    detectedVia: "pubspec.yaml dependency",
  },
  {
    id: "shelf",
    name: "Shelf",
    check: (info) => hasPubspecDep(info, "shelf") || hasPubspecDep(info, "shelf_router"),
    detectedVia: "pubspec.yaml dependency",
  },
  {
    id: "dart_frog",
    name: "Dart Frog",
    check: (info) => hasPubspecDep(info, "dart_frog"),
    detectedVia: "pubspec.yaml dependency",
  },
];

function hasDep(info: ProjectInfo, name: string): boolean {
  if (!info.packageJson) return false;
  const deps = info.packageJson.dependencies as Record<string, string> | undefined;
  const devDeps = info.packageJson.devDependencies as Record<string, string> | undefined;
  return !!(deps?.[name] || devDeps?.[name]);
}

function hasPythonDep(info: ProjectInfo, name: string): boolean {
  if (!info.pythonManifest) return false;
  const deps = info.pythonManifest.dependencies as string[] | undefined;
  if (Array.isArray(deps)) {
    return deps.some((d) => d.toLowerCase().startsWith(name));
  }
  // Check requirements-style
  const all = JSON.stringify(info.pythonManifest).toLowerCase();
  return all.includes(name);
}

function hasGradleDep(info: ProjectInfo, name: string): boolean {
  if (!info.gradleFile) return false;
  return info.gradleFile.includes(name);
}

function hasDelphiDep(info: ProjectInfo, name: string): boolean {
  return info.delphiUses.some((u) => u.startsWith(name));
}

function hasMavenDep(info: ProjectInfo, name: string): boolean {
  if (!info.pomXml) return false;
  return info.pomXml.includes(name);
}

function hasCsprojPackage(info: ProjectInfo, name: string): boolean {
  if (!info.csprojText) return false;
  // `<PackageReference Include="Microsoft.EntityFrameworkCore" ...>`. The match
  // is anchored at the start of the name only (no closing `"`), so it is a
  // prefix match — `"Microsoft.AspNetCore.Components"` also matches
  // `Microsoft.AspNetCore.Components.WebView.Wpf`.
  const re = new RegExp(`PackageReference[^>]*Include\\s*=\\s*"${escapeRegex(name)}`, "i");
  return re.test(info.csprojText);
}

/** `<Project Sdk="Microsoft.NET.Sdk.Web">` (Web SDK vs the base/Razor SDKs). */
function hasCsprojSdk(info: ProjectInfo, sdk: string): boolean {
  if (!info.csprojText) return false;
  return new RegExp(`Sdk\\s*=\\s*"${escapeRegex(sdk)}"`, "i").test(info.csprojText);
}

/** A boolean MSBuild property toggle, e.g. `<UseWPF>true</UseWPF>`. */
function hasCsprojProp(info: ProjectInfo, prop: string): boolean {
  if (!info.csprojText) return false;
  return new RegExp(`<${escapeRegex(prop)}>\\s*true\\s*</${escapeRegex(prop)}>`, "i").test(info.csprojText);
}

/** `<FrameworkReference Include="Microsoft.AspNetCore.App" />` (shared framework). */
function hasCsprojFrameworkRef(info: ProjectInfo, name: string): boolean {
  if (!info.csprojText) return false;
  return new RegExp(`FrameworkReference[^>]*Include\\s*=\\s*"${escapeRegex(name)}`, "i").test(info.csprojText);
}

function hasGoMod(info: ProjectInfo, name: string): boolean {
  if (!info.goMod) return false;
  return info.goMod.includes(name);
}

function hasCargoDep(info: ProjectInfo, name: string): boolean {
  if (!info.cargoToml) return false;
  // Match `name = ...` or `name = { ... }` at line start
  const re = new RegExp(`^\\s*${escapeRegex(name)}\\s*=`, "m");
  return re.test(info.cargoToml);
}

function hasComposerDep(info: ProjectInfo, name: string): boolean {
  if (!info.composerJson) return false;
  return info.composerJson.includes(`"${name}"`);
}

function hasGemfileDep(info: ProjectInfo, name: string): boolean {
  if (!info.gemfile) return false;
  // `gem "name"` or `gem 'name'`
  const re = new RegExp(`gem\\s+['"]${escapeRegex(name)}['"]`, "m");
  return re.test(info.gemfile);
}

function hasPubspecDep(info: ProjectInfo, name: string): boolean {
  if (!info.pubspecYaml) return false;
  // A dependency is an indented `  name:` key under dependencies/dev_dependencies.
  // The leading whitespace requirement avoids matching the top-level `flutter:`
  // config section (which is column-0) — only the `flutter:` *dependency* counts.
  const re = new RegExp(`^\\s+${escapeRegex(name)}\\s*:`, "m");
  return re.test(info.pubspecYaml);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Gather project info from manifest files */
export async function gatherProjectInfo(
  projectRoot: string,
): Promise<ProjectInfo> {
  const root = resolve(projectRoot);

  // Read package.json
  let packageJson: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(join(root, "package.json"), "utf-8");
    packageJson = JSON.parse(raw);
  } catch {
    // No package.json
  }

  // Find .csproj files
  const csprojFiles = await fg("**/*.csproj", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 3,
  });

  // Concatenate .csproj contents for PackageReference scanning.
  let csprojText = "";
  for (const f of csprojFiles.slice(0, 20)) {
    try {
      csprojText += "\n" + (await readFile(join(root, f), "utf-8"));
    } catch {
      // Skip unreadable file
    }
  }

  // Read Python manifest (pyproject.toml as JSON-compatible or requirements.txt)
  let pythonManifest: Record<string, unknown> | null = null;
  try {
    const reqRaw = await readFile(join(root, "requirements.txt"), "utf-8");
    pythonManifest = {
      dependencies: reqRaw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    };
  } catch {
    // Try pyproject.toml (basic parse)
    try {
      const raw = await readFile(join(root, "pyproject.toml"), "utf-8");
      // Extract dependencies line by line (simple parse, not full TOML)
      const deps: string[] = [];
      let inDeps = false;
      for (const line of raw.split("\n")) {
        if (line.match(/^\[.*dependencies.*\]/i)) {
          inDeps = true;
          continue;
        }
        if (line.startsWith("[") && inDeps) break;
        if (inDeps) {
          const match = line.match(/["']([^"']+)["']/);
          if (match) deps.push(match[1]);
        }
      }
      if (deps.length > 0) {
        pythonManifest = { dependencies: deps };
      }
    } catch {
      // No Python manifest
    }
  }

  // Read Gradle build file
  let gradleFile: string | null = null;
  for (const name of ["build.gradle.kts", "build.gradle"]) {
    try {
      gradleFile = await readFile(join(root, name), "utf-8");
      break;
    } catch {
      // Try next
    }
  }

  // Read Maven pom.xml
  let pomXml: string | null = null;
  try {
    pomXml = await readFile(join(root, "pom.xml"), "utf-8");
  } catch {
    // No pom.xml
  }

  // Get file extensions
  const fileExtensions = new Set<string>();
  const sampleFiles = await fg("**/*.*", {
    cwd: root,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/bin/**",
      "**/obj/**",
    ],
    absolute: false,
    deep: 3,
  });
  for (const f of sampleFiles) {
    const dot = f.lastIndexOf(".");
    if (dot >= 0) fileExtensions.add(f.slice(dot));
  }

  // Find .dproj files (Delphi)
  const dprojFiles = await fg("**/*.dproj", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 3,
  });

  // Find .lpi files (Lazarus)
  const lpiFiles = await fg("**/*.lpi", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 3,
  });

  // Scan a few Pascal source files for uses clauses (for framework detection)
  const delphiUses: string[] = [];
  const pasFiles = await fg("**/*.{pas,dpr,lpr}", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**", "**/__history/**"],
    absolute: false,
    deep: 3,
  });
  for (const pf of pasFiles.slice(0, 10)) {
    try {
      const content = await readFile(join(root, pf), "utf-8");
      // Simple regex to extract unit names from uses clauses
      const usesMatches = content.matchAll(/\buses\b\s+([\s\S]*?);/gi);
      for (const m of usesMatches) {
        const units = m[1].split(",").map((u) => u.trim().replace(/\s+/g, ""));
        delphiUses.push(...units.filter((u) => u.length > 0));
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Read go.mod, Cargo.toml, composer.json, Gemfile — for cross-language ORM detection.
  let goMod: string | null = null;
  try { goMod = await readFile(join(root, "go.mod"), "utf-8"); } catch { /* no go.mod */ }

  let cargoToml: string | null = null;
  try { cargoToml = await readFile(join(root, "Cargo.toml"), "utf-8"); } catch { /* no Cargo.toml */ }

  let composerJson: string | null = null;
  try { composerJson = await readFile(join(root, "composer.json"), "utf-8"); } catch { /* no composer.json */ }

  let gemfile: string | null = null;
  try { gemfile = await readFile(join(root, "Gemfile"), "utf-8"); } catch { /* no Gemfile */ }

  let pubspecYaml: string | null = null;
  try { pubspecYaml = await readFile(join(root, "pubspec.yaml"), "utf-8"); } catch { /* no pubspec.yaml */ }

  let cmakeLists: string | null = null;
  try { cmakeLists = await readFile(join(root, "CMakeLists.txt"), "utf-8"); } catch { /* no CMakeLists.txt */ }

  // Find .sql / .ddl files for raw-SQL framework detection
  const sqlFiles = await fg("**/*.{sql,ddl,dml,psql,tsql,plsql,mysql}", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 5,
  });

  // JSP views + Spring Web Flow definitions (Java web monoliths nest these
  // deep under src/main/webapp/, hence the higher depth).
  const jspFiles = await fg("**/*.jsp", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/target/**", "**/.git/**"],
    absolute: false,
    deep: 8,
  });
  const webflowFiles = await fg(["**/*webflow*.xml", "**/WEB-INF/flows/**/*.xml"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/target/**", "**/.git/**"],
    absolute: false,
    deep: 9,
  });

  // Framework marker files no manifest records (vendored frameworks).
  const markerFiles = MARKER_CANDIDATES.filter((rel) =>
    existsSync(join(root, ...rel.split("/"))),
  );

  return {
    root,
    packageJson,
    csprojFiles,
    csprojText,
    pythonManifest,
    gradleFile,
    pomXml,
    fileExtensions,
    dprojFiles,
    lpiFiles,
    delphiUses,
    goMod,
    cargoToml,
    composerJson,
    gemfile,
    pubspecYaml,
    sqlFiles,
    jspFiles,
    webflowFiles,
    cmakeLists,
    markerFiles,
  };
}

/** Detect frameworks used in the project */
export function detectFrameworks(
  projectInfo: ProjectInfo,
): FrameworkDetection[] {
  const results: FrameworkDetection[] = [];

  for (const rule of FRAMEWORK_RULES) {
    if (rule.check(projectInfo)) {
      results.push({
        id: rule.id,
        name: rule.name,
        confidence: "high",
        detectedVia: rule.detectedVia,
      });
    }
  }

  return results;
}

export interface MultiRootFrameworks {
  /** De-duped union across the analyzed root and every sub-project root. */
  merged: FrameworkDetection[];
  /** Per-root detections, keyed by the (relative) root string passed in (`""` = analyzed root). */
  byRoot: Map<string, FrameworkDetection[]>;
}

/**
 * Detect frameworks at the analyzed root AND at each sub-project root, merging
 * the results. Build manifests (`package.json`, `Gemfile`, `*.csproj`, …) are
 * frequently nested — a `/spa` Vue app beside a `/server` Rails app under one
 * repo, or a wrapper dir whose real app lives a level down — so a root-only scan
 * (which reads `package.json`/`Gemfile`/`go.mod`/… at exactly the root) sees
 * none of them and the project looks frameworkless. Gathering per sub-project
 * root closes that gap. Detections are de-duped by framework id, first wins.
 *
 * `subRoots` are relative to `projectRoot` (the same strings carried on
 * `SubProject.root`); `""` denotes the analyzed root and is always included.
 */
export async function detectFrameworksAcrossRoots(
  projectRoot: string,
  subRoots: readonly string[],
): Promise<MultiRootFrameworks> {
  const roots = ["", ...subRoots].filter((r, i, a) => a.indexOf(r) === i);
  const byRoot = new Map<string, FrameworkDetection[]>();
  const merged = new Map<string, FrameworkDetection>();
  for (const rel of roots) {
    const info = await gatherProjectInfo(rel ? resolve(projectRoot, rel) : projectRoot);
    const fws = detectFrameworks(info);
    byRoot.set(rel, fws);
    for (const f of fws) if (!merged.has(f.id)) merged.set(f.id, f);
  }
  return { merged: [...merged.values()], byRoot };
}
