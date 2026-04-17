import type { Language } from "../types/analysis.js";
import { resolve, dirname } from "path";
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
    id: "csharp",
    languageIds: ["csharp"],
    dockerImage: "reversedoc-lsp-csharp",
    dockerfilePath: resolve(projectDir, "docker/csharp"),
    serverCommand: [],
    mountPath: "/workspace",
    fileExtensions: [".cs"],
    readOnly: false, // OmniSharp needs dotnet restore (entrypoint runs it)
    indexDelayMs: 15000, // OmniSharp needs extra time to restore and index
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
