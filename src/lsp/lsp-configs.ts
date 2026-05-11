import type { Language } from "../types/analysis.js";
import type { LspClient } from "./lsp-client.js";
import { readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In source: src/lsp/ → up 2. In bundled dist/: dist/ → up 1.
// We detect by checking if __dirname ends with "lsp" (source) vs not (bundled).
const projectDir = __dirname.replace(/\\/g, "/").endsWith("/lsp")
  ? resolve(__dirname, "..", "..")
  : resolve(__dirname, "..");

export interface LspDockerConfig {
  id: string;
  languageIds: Language[];
  dockerImage: string;
  dockerfilePath: string;
  serverCommand: string[];
  mountPath: string;
  fileExtensions: string[];
  readOnly?: boolean;
  indexDelayMs?: number;
  initializationOptions?: Record<string, unknown>;
  /**
   * Optional post-init hook — runs after `initialized` is sent but before documents open.
   * Used for server-specific workspace setup (e.g., Roslyn's `project/open`).
   */
  postInitialize?: (client: LspClient, projectRoot: string) => void;
}

export const LSP_CONFIGS: LspDockerConfig[] = [
  {
    id: "typescript",
    languageIds: ["typescript", "javascript"],
    dockerImage: "reversedoc-lsp-typescript",
    dockerfilePath: resolve(projectDir, "docker/typescript"),
    serverCommand: [], // Uses ENTRYPOINT from Dockerfile
    mountPath: "/workspace",
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    readOnly: true,
    initializationOptions: {
      preferences: {
        includeInlayParameterNameHints: "none",
        includeInlayPropertyDeclarationTypeHints: false,
      },
    },
  },
  {
    id: "python",
    languageIds: ["python"],
    dockerImage: "reversedoc-lsp-python",
    dockerfilePath: resolve(projectDir, "docker/python"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".py"],
    readOnly: true,
  },
  {
    id: "java",
    languageIds: ["java"],
    dockerImage: "reversedoc-lsp-java",
    dockerfilePath: resolve(projectDir, "docker/java"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".java"],
    readOnly: false, // jdtls needs to write .project/.classpath
    indexDelayMs: 10000, // jdtls needs extra time to build project model
  },
  {
    id: "kotlin",
    languageIds: ["kotlin"],
    dockerImage: "reversedoc-lsp-kotlin",
    dockerfilePath: resolve(projectDir, "docker/kotlin"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".kt", ".kts"],
    readOnly: false, // kotlin-ls may need to build
  },
  {
    id: "go",
    languageIds: ["go"],
    dockerImage: "reversedoc-lsp-go",
    dockerfilePath: resolve(projectDir, "docker/go"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".go"],
    readOnly: true,
    indexDelayMs: 5000, // gopls needs time to load module graph
  },
  {
    id: "rust",
    languageIds: ["rust"],
    dockerImage: "reversedoc-lsp-rust",
    dockerfilePath: resolve(projectDir, "docker/rust"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".rs"],
    readOnly: false, // rust-analyzer needs to run cargo check
    indexDelayMs: 15000, // rust-analyzer needs time to build and index
  },
  {
    id: "ruby",
    languageIds: ["ruby"],
    dockerImage: "reversedoc-lsp-ruby",
    dockerfilePath: resolve(projectDir, "docker/ruby"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".rb"],
    readOnly: true,
  },
  {
    id: "php",
    languageIds: ["php"],
    dockerImage: "reversedoc-lsp-php",
    dockerfilePath: resolve(projectDir, "docker/php"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".php"],
    readOnly: true,
  },
  {
    // pascal-language-server (pasls) from genericptr — FPC-based, uses Lazarus
    // CodeTools for semantic analysis. Handles Delphi-mode syntax but unit
    // resolution for Delphi-only namespaces (VCL.*, FMX.*) is best-effort.
    id: "pascal",
    languageIds: ["pascal"],
    dockerImage: "reversedoc-lsp-pascal",
    dockerfilePath: resolve(projectDir, "docker/pascal"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".pas", ".pp", ".dpr", ".dpk", ".lpr", ".inc"],
    readOnly: true,
    indexDelayMs: 5000,
  },
  {
    // Microsoft.CodeAnalysis.LanguageServer (Roslyn) — serves both C# and VB.NET.
    // Uses misterkiem/roslyn-plusvb fork which patches VB libs into the upstream server.
    id: "dotnet",
    languageIds: ["csharp", "vb"],
    dockerImage: "reversedoc-lsp-dotnet",
    dockerfilePath: resolve(projectDir, "docker/dotnet"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".cs", ".vb"],
    readOnly: false, // Roslyn LSP needs dotnet restore output
    indexDelayMs: 15000, // Roslyn needs time to load sln/*proj and build workspace
    // Roslyn requires an explicit `solution/open` or `project/open` notification to
    // load a workspace — the LSP initialize handshake alone leaves it in single-file mode.
    postInitialize: (client, projectRoot) => {
      const walk = (dir: string, depth: number, acc: string[]): string[] => {
        if (depth > 6) return acc;
        let entries: import("fs").Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return acc;
        }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === "bin" || e.name === "obj" || e.name.startsWith(".")) continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1, acc);
          else if (/\.(sln|slnx|slnf|vbproj|csproj)$/i.test(e.name)) acc.push(full);
        }
        return acc;
      };
      const found = walk(projectRoot, 0, []);
      const toRel = (abs: string) =>
        abs.slice(projectRoot.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");

      const slns = found.filter((f) => /\.(sln|slnx|slnf)$/i.test(f));
      if (slns.length > 0) {
        client.notify("solution/open", {
          solution: client.toUri(toRel(slns[0]!)),
        });
        return;
      }
      const projects = found.filter((f) => /\.(vbproj|csproj)$/i.test(f));
      if (projects.length > 0) {
        client.notify("project/open", {
          projects: projects.map((p) => client.toUri(toRel(p))),
        });
      }
    },
  },
];

/**
 * Get the LSP config for a given language.
 * Returns null for languages without LSP support (e.g., pascal/dfm).
 */
export function getConfigForLanguage(language: Language): LspDockerConfig | null {
  return LSP_CONFIGS.find((c) => c.languageIds.includes(language)) ?? null;
}

/**
 * Get all unique configs needed for a set of languages.
 */
export function getConfigsForLanguages(languages: Set<Language>): LspDockerConfig[] {
  const seen = new Set<string>();
  const configs: LspDockerConfig[] = [];

  for (const lang of languages) {
    const config = getConfigForLanguage(lang);
    if (config && !seen.has(config.id)) {
      seen.add(config.id);
      configs.push(config);
    }
  }

  return configs;
}
