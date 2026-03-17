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

  return {
    root,
    packageJson,
    csprojFiles,
    pythonManifest,
    gradleFile,
    pomXml,
    fileExtensions,
    dprojFiles,
    lpiFiles,
    delphiUses,
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
