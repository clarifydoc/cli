import type {
  FileAnalysis,
  SymbolLink,
  CallInfo,
  Language,
  LspStats,
} from "../types/analysis.js";
import type { DiscoveredFile } from "../core/file-discovery.js";
import { LspManager } from "./lsp-manager.js";

export interface LspEnhancerOptions {
  projectRoot: string;
  analyses: FileAnalysis[];
  existingLinks: SymbolLink[];
  files: DiscoveredFile[];
  verbose: boolean;
  timeout?: number;
}

export interface LspEnhancementResult {
  enhancedLinks: SymbolLink[];
  serversUsed: string[];
  lspResolvedCount: number;
  referenceLinksCount: number;
  timeMs: number;
}

/**
 * Enhance symbol links using LSP servers running in Docker containers.
 *
 * Phase A: Resolve unresolved calls via textDocument/definition
 * Phase B: Find references via textDocument/references
 */
export async function enhanceWithLsp(options: LspEnhancerOptions): Promise<LspEnhancementResult> {
  const startTime = Date.now();
  const { projectRoot, analyses, existingLinks, files, verbose, timeout = 60000 } = options;

  // Collect all languages present in the analyses
  const languages = new Set<Language>();
  for (const a of analyses) {
    languages.add(a.language);
  }

  // Initialize LSP servers
  const manager = new LspManager({ projectRoot, verbose, timeout });
  let serversUsed: string[] = [];

  try {
    serversUsed = await manager.initialize(languages, files);

    if (serversUsed.length === 0) {
      return {
        enhancedLinks: existingLinks,
        serversUsed: [],
        lspResolvedCount: 0,
        referenceLinksCount: 0,
        timeMs: Date.now() - startTime,
      };
    }

    if (verbose) {
      console.log(`  LSP servers started: ${serversUsed.join(", ")}`);
    }

    // Phase A: Resolve unresolved calls
    const { newLinks: definitionLinks, resolvedCount } = await resolveUnresolvedCalls(
      analyses, existingLinks, manager, verbose,
    );

    // Phase B: Find references for exported symbols
    const referenceLinks = await findReferences(
      analyses, existingLinks, definitionLinks, manager, verbose,
    );

    // Merge all links
    const allLinks = [...existingLinks, ...definitionLinks, ...referenceLinks];
    const deduped = deduplicateLinks(allLinks);

    if (verbose) {
      console.log(`  LSP resolved ${resolvedCount} definitions, ${referenceLinks.length} references`);
    }

    return {
      enhancedLinks: deduped,
      serversUsed,
      lspResolvedCount: resolvedCount,
      referenceLinksCount: referenceLinks.length,
      timeMs: Date.now() - startTime,
    };
  } finally {
    await manager.shutdownAll();
  }
}

// ─── Phase A: Resolve unresolved calls ──────────────────────────────────

interface UnresolvedCall {
  sourceFile: string;
  sourceSymbol: string;
  call: CallInfo;
  language: Language;
}

async function resolveUnresolvedCalls(
  analyses: FileAnalysis[],
  existingLinks: SymbolLink[],
  manager: LspManager,
  verbose: boolean,
): Promise<{ newLinks: SymbolLink[]; resolvedCount: number }> {
  // Build set of already-resolved calls
  const resolvedSet = new Set<string>();
  for (const link of existingLinks) {
    resolvedSet.add(`${link.sourceFile}::${link.sourceLine}::${link.callName}`);
  }

  // Collect unresolved calls
  const unresolved: UnresolvedCall[] = [];

  for (const analysis of analyses) {
    const lang = analysis.language;

    // From functions
    for (const fn of analysis.functions) {
      for (const call of fn.calls) {
        if (shouldSkipCall(call, analysis.filePath, fn.name, resolvedSet)) continue;
        unresolved.push({
          sourceFile: analysis.filePath,
          sourceSymbol: fn.name,
          call,
          language: lang,
        });
      }
    }

    // From class methods
    for (const cls of analysis.classes) {
      for (const method of cls.methods) {
        const sourceSymbol = `${cls.name}.${method.name}`;
        for (const call of method.calls) {
          if (shouldSkipCall(call, analysis.filePath, sourceSymbol, resolvedSet)) continue;
          unresolved.push({
            sourceFile: analysis.filePath,
            sourceSymbol,
            call,
            language: lang,
          });
        }
      }
    }

    // From routes
    for (const route of analysis.routes) {
      const sourceSymbol = `route:${route.httpMethod ?? "USE"} ${route.path}`;
      for (const call of route.calls) {
        if (shouldSkipCall(call, analysis.filePath, sourceSymbol, resolvedSet)) continue;
        unresolved.push({
          sourceFile: analysis.filePath,
          sourceSymbol,
          call,
          language: lang,
        });
      }
    }

    // From data sources
    for (const ds of analysis.dataSources) {
      for (const call of ds.calls) {
        if (shouldSkipCall(call, analysis.filePath, ds.name, resolvedSet)) continue;
        unresolved.push({
          sourceFile: analysis.filePath,
          sourceSymbol: ds.name,
          call,
          language: lang,
        });
      }
    }
  }

  if (verbose) {
    console.log(`  LSP: ${unresolved.length} unresolved calls to query`);
  }

  // Query LSP for each unresolved call (with concurrency limit)
  const newLinks: SymbolLink[] = [];
  let resolvedCount = 0;

  const concurrency = 10;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < unresolved.length) {
      const idx = nextIndex++;
      const item = unresolved[idx]!;
      const client = manager.getClientForLanguage(item.language);
      if (!client) continue;

      try {
        // LSP uses 0-based lines, our CallInfo uses 1-based
        const lspLine = item.call.line - 1;
        const lspCol = item.call.column ?? 0;

        const definitions = await client.getDefinition(
          item.sourceFile,
          lspLine,
          lspCol,
        );

        if (definitions.length > 0) {
          const def = definitions[0]!;
          newLinks.push({
            sourceFile: item.sourceFile,
            sourceSymbol: item.sourceSymbol,
            sourceLine: item.call.line,
            callName: item.call.name,
            targetFile: def.uri,
            targetSymbol: item.call.name,
            targetLine: def.line + 1, // Convert back to 1-based
            resolvedBy: "lsp",
          });
          resolvedCount++;
        }
      } catch {
        // Individual request failed — skip silently
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, unresolved.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return { newLinks, resolvedCount };
}

// ─── Phase B: Find references ───────────────────────────────────────────

async function findReferences(
  analyses: FileAnalysis[],
  existingLinks: SymbolLink[],
  definitionLinks: SymbolLink[],
  manager: LspManager,
  verbose: boolean,
): Promise<SymbolLink[]> {
  // Build set of all known link keys for dedup
  const knownKeys = new Set<string>();
  for (const link of [...existingLinks, ...definitionLinks]) {
    knownKeys.add(`${link.targetFile}::${link.targetSymbol}::${link.sourceFile}::${link.callName}`);
  }

  // Collect exported symbols to find references for
  interface ExportedSymbol {
    filePath: string;
    name: string;
    line: number;
    language: Language;
  }

  const symbols: ExportedSymbol[] = [];

  for (const analysis of analyses) {
    // Exported functions
    for (const fn of analysis.functions) {
      if (fn.isExported) {
        symbols.push({
          filePath: analysis.filePath,
          name: fn.name,
          line: fn.line,
          language: analysis.language,
        });
      }
    }

    // Exported classes and their methods
    for (const cls of analysis.classes) {
      if (cls.isExported) {
        symbols.push({
          filePath: analysis.filePath,
          name: cls.name,
          line: cls.line,
          language: analysis.language,
        });

        for (const method of cls.methods) {
          symbols.push({
            filePath: analysis.filePath,
            name: `${cls.name}.${method.name}`,
            line: method.line,
            language: analysis.language,
          });
        }
      }
    }
  }

  if (verbose) {
    console.log(`  LSP: Finding references for ${symbols.length} exported symbols`);
  }

  const referenceLinks: SymbolLink[] = [];
  const concurrency = 10;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < symbols.length) {
      const idx = nextIndex++;
      const sym = symbols[idx]!;
      const client = manager.getClientForLanguage(sym.language);
      if (!client || !client.supportsReferences) continue;

      try {
        const refs = await client.getReferences(
          sym.filePath,
          sym.line - 1, // 0-based
          0,
        );

        for (const ref of refs) {
          // Skip self-references
          if (ref.uri === sym.filePath && ref.line + 1 === sym.line) continue;

          const key = `${sym.filePath}::${sym.name}::${ref.uri}::${sym.name}`;
          if (knownKeys.has(key)) continue;
          knownKeys.add(key);

          referenceLinks.push({
            sourceFile: ref.uri,
            sourceSymbol: "(reference)",
            sourceLine: ref.line + 1,
            callName: sym.name,
            targetFile: sym.filePath,
            targetSymbol: sym.name,
            targetLine: sym.line,
            resolvedBy: "lsp",
          });
        }
      } catch {
        // Individual request failed — skip silently
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, symbols.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return referenceLinks;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function shouldSkipCall(
  call: CallInfo,
  sourceFile: string,
  sourceSymbol: string,
  resolvedSet: Set<string>,
): boolean {
  // Skip non-resolvable kinds
  if (call.kind === "api-call" || call.kind === "database") return true;
  // Skip already resolved
  const key = `${sourceFile}::${call.line}::${call.name}`;
  return resolvedSet.has(key);
}

function deduplicateLinks(links: SymbolLink[]): SymbolLink[] {
  const seen = new Set<string>();
  const deduped: SymbolLink[] = [];

  for (const link of links) {
    const key = `${link.sourceFile}::${link.sourceSymbol}::${link.targetFile}::${link.targetSymbol}::${link.callName}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(link);
    }
  }

  return deduped;
}
