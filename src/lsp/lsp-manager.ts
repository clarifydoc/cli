import { readFile } from "fs/promises";
import type { Language } from "../types/analysis.js";
import type { DiscoveredFile } from "../core/file-discovery.js";
import { LspClient } from "./lsp-client.js";
import {
  isDockerAvailable,
  imageExists,
  buildImage,
  startContainer,
  stopContainer,
  stopAllContainers,
  type DockerContainer,
} from "./docker-runner.js";
import {
  getConfigsForLanguages,
  type LspDockerConfig,
} from "./lsp-configs.js";

/** Map from reverseDoc Language to LSP languageId string */
const LANGUAGE_ID_MAP: Record<string, string> = {
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  java: "java",
  kotlin: "kotlin",
  csharp: "csharp",
};

/** Map file extension to LSP languageId */
function extensionToLanguageId(filePath: string): string {
  if (filePath.endsWith(".tsx")) return "typescriptreact";
  if (filePath.endsWith(".jsx")) return "javascriptreact";
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return "javascript";
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".kt") || filePath.endsWith(".kts")) return "kotlin";
  if (filePath.endsWith(".cs")) return "csharp";
  return "plaintext";
}

interface ActiveServer {
  config: LspDockerConfig;
  container: DockerContainer;
  client: LspClient;
}

export interface LspManagerOptions {
  projectRoot: string;
  verbose: boolean;
  timeout: number;
}

/**
 * Manages LSP server Docker containers for a single analysis run.
 * Starts one container per language group, handles lifecycle and cleanup.
 */
export class LspManager {
  private servers = new Map<string, ActiveServer>();
  private languageToConfig = new Map<Language, string>();
  private projectRoot: string;
  private verbose: boolean;
  private timeout: number;
  private cleanupRegistered = false;

  constructor(options: LspManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.verbose = options.verbose;
    this.timeout = options.timeout;
  }

  /**
   * Initialize LSP servers for the given languages.
   * Builds Docker images if needed, starts containers, opens documents.
   */
  async initialize(
    languages: Set<Language>,
    files: DiscoveredFile[],
  ): Promise<string[]> {
    // Check Docker availability
    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      console.warn("Warning: Docker is not available. LSP enhancement will be skipped.");
      console.warn("  Install Docker to enable LSP-based symbol resolution.");
      return [];
    }

    this.registerCleanup();

    const configs = getConfigsForLanguages(languages);
    if (configs.length === 0) return [];

    const startedServers: string[] = [];

    for (const config of configs) {
      try {
        await this.startServer(config, files);
        startedServers.push(config.id);

        for (const lang of config.languageIds) {
          if (languages.has(lang)) {
            this.languageToConfig.set(lang, config.id);
          }
        }
      } catch (err) {
        console.warn(`Warning: Failed to start LSP server '${config.id}': ${(err as Error).message}`);
      }
    }

    return startedServers;
  }

  /**
   * Get the LSP client for a specific language.
   * Returns null if no server is available for that language.
   */
  getClientForLanguage(language: Language): LspClient | null {
    const configId = this.languageToConfig.get(language);
    if (!configId) return null;
    return this.servers.get(configId)?.client ?? null;
  }

  /**
   * Shut down all running LSP servers and their containers.
   */
  async shutdownAll(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];

    for (const [id, server] of this.servers) {
      if (this.verbose) console.log(`  Shutting down LSP server: ${id}`);
      shutdownPromises.push(
        server.client.shutdown()
          .catch(() => {})
          .then(() => stopContainer(server.container))
          .catch(() => {}),
      );
    }

    await Promise.all(shutdownPromises);
    this.servers.clear();
    this.languageToConfig.clear();
  }

  // ─── Private methods ──────────────────────────────────────────────────

  private async startServer(config: LspDockerConfig, files: DiscoveredFile[]): Promise<void> {
    // Build image if it doesn't exist
    const exists = await imageExists(config.dockerImage);
    if (!exists) {
      if (this.verbose) console.log(`  Building Docker image: ${config.dockerImage}...`);
      await buildImage(config.dockerfilePath, config.dockerImage, this.verbose);
    }

    // Start container
    if (this.verbose) console.log(`  Starting LSP server: ${config.id}...`);
    const container = startContainer({
      image: config.dockerImage,
      command: config.serverCommand,
      projectRoot: this.projectRoot,
      mountPath: config.mountPath,
      name: `reversedoc-lsp-${config.id}-${Date.now()}`,
      readOnly: config.readOnly,
    });

    // Create LSP client
    const client = new LspClient({
      stdin: container.stdin,
      stdout: container.stdout,
      projectRoot: this.projectRoot,
      mountPath: config.mountPath,
      initializationOptions: config.initializationOptions,
    });

    // Initialize with timeout
    await Promise.race([
      client.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`LSP initialize timed out after ${this.timeout}ms`)), this.timeout),
      ),
    ]);

    if (this.verbose) {
      console.log(`  LSP server ${config.id}: definition=${client.supportsDefinition}, references=${client.supportsReferences}`);
    }

    this.servers.set(config.id, { config, container, client });

    // Open relevant files so the server can build its project model
    const relevantFiles = files.filter((f) =>
      config.fileExtensions.some((ext) => f.relativePath.endsWith(ext)),
    );

    if (this.verbose) {
      console.log(`  Opening ${relevantFiles.length} files for ${config.id}...`);
    }

    // Open files in batches to avoid overwhelming the server
    const batchSize = 50;
    for (let i = 0; i < relevantFiles.length; i += batchSize) {
      const batch = relevantFiles.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (file) => {
          try {
            const text = await readFile(file.absolutePath, "utf-8");
            const langId = extensionToLanguageId(file.relativePath);
            client.openDocument(file.relativePath, langId, text);
          } catch {
            // Skip files that can't be read
          }
        }),
      );
      // Small delay between batches to let the server process
      if (i + batchSize < relevantFiles.length) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Give the server time to index after all files are opened
    const indexDelay = config.indexDelayMs ?? 1000;
    if (this.verbose) console.log(`  Waiting ${indexDelay}ms for ${config.id} to index...`);
    await new Promise((r) => setTimeout(r, indexDelay));
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = () => {
      stopAllContainers().catch(() => {});
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(1);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(1);
    });
  }
}
