import { readFile } from "fs/promises";
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

  // C# frameworks
  {
    id: "aspnet",
    name: "ASP.NET",
    check: (info) => info.csprojFiles.length > 0,
    detectedVia: ".csproj file",
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
  // Raw SQL — surfaced when *.sql / *.ddl files exist
  {
    id: "sql",
    name: "SQL",
    check: (info) => info.sqlFiles.length > 0,
    detectedVia: ".sql / .ddl files",
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
  // `<PackageReference Include="Microsoft.EntityFrameworkCore" ...>`
  const re = new RegExp(`PackageReference[^>]*Include\\s*=\\s*"${escapeRegex(name)}`, "i");
  return re.test(info.csprojText);
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

  // Find .sql / .ddl files for raw-SQL framework detection
  const sqlFiles = await fg("**/*.{sql,ddl,dml,psql,tsql,plsql,mysql}", {
    cwd: root,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/bin/**", "**/obj/**"],
    absolute: false,
    deep: 5,
  });

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
    sqlFiles,
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
