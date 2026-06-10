import type {
  FileAnalysis,
  SymbolLink,
  CallInfo,
  Language,
  LspStats,
} from "../types/analysis.js";
import { BEST_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";
import type { DiscoveredFile } from "../core/file-discovery.js";
import { LspManager } from "./lsp-manager.js";
import { buildInterfaceImplMap, type InterfaceImplInfo } from "../core/symbol-linker.js";

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
 * Throttled live progress for the long LSP loops. Non-verbose uses a `\r`
 * overwritten status line; verbose prints periodic newlines so the verbose log
 * stays parsable. `finalize` always lands on its own line so following output
 * doesn't get clobbered.
 */
function makeTicker(total: number, label: string, verbose: boolean) {
  let done = 0;
  let lastWriteAt = 0;
  let lastPrinted = -1;
  return {
    tick() {
      done++;
      const now = Date.now();
      const isLast = done === total;
      if (verbose) {
        if (isLast || done - lastPrinted >= Math.max(25, Math.floor(total / 20))) {
          console.log(`  ${label}: ${done}/${total}`);
          lastPrinted = done;
        }
        return;
      }
      if (!isLast && now - lastWriteAt < 200) return;
      lastWriteAt = now;
      process.stdout.write(`\r  ${label}: ${done}/${total}   `);
    },
    finalize() {
      if (verbose) {
        if (lastPrinted !== done) console.log(`  ${label}: ${done}/${total}`);
      } else {
        process.stdout.write(`\r  ${label}: ${done}/${total}   \n`);
      }
    },
  };
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

    console.log(`  LSP servers started: ${serversUsed.join(", ")}`);

    // Phase A: Resolve unresolved calls
    const { newLinks: definitionLinks, resolvedCount } = await resolveUnresolvedCalls(
      analyses, existingLinks, manager, verbose,
    );

    // Phase B: Find references for exported symbols
    const referenceLinks = await findReferences(
      analyses, existingLinks, definitionLinks, manager, verbose,
    );

    // Redirect LSP-resolved interface/field targets to the concrete implementation
    // when there's exactly one. C# OmniSharp's textDocument/definition for a call
    // like `_userService.CreateAsync()` often lands on the interface method or the
    // field declaration — neither of which is what a reader navigating a call graph
    // wants. We rewrite those to the implementing class's method.
    const ifaceMap = buildInterfaceImplMap(analyses);
    const redirectedDefinitions = definitionLinks.map((l) =>
      redirectThroughInterface(l, analyses, ifaceMap),
    );

    // Merge all links
    const allLinks = [...existingLinks, ...redirectedDefinitions, ...referenceLinks];
    const deduped = deduplicateLinks(allLinks);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `  LSP done: +${resolvedCount} defs, +${referenceLinks.length} refs in ${elapsedSec}s`,
    );

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

  console.log(`  LSP: ${unresolved.length} unresolved calls to query`);

  // Query LSP for each unresolved call (with concurrency limit)
  const newLinks: SymbolLink[] = [];
  let resolvedCount = 0;

  const concurrency = 10;
  let nextIndex = 0;
  const ticker = makeTicker(unresolved.length, "LSP defs", verbose);

  async function worker() {
    while (nextIndex < unresolved.length) {
      const idx = nextIndex++;
      const item = unresolved[idx]!;
      const client = manager.getClientForLanguage(item.language);
      if (!client) {
        ticker.tick();
        continue;
      }

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
            confidence: "INFERRED",
          });
          resolvedCount++;
        }
      } catch {
        // Individual request failed — skip silently
      } finally {
        ticker.tick();
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, unresolved.length) },
    () => worker(),
  );
  await Promise.all(workers);
  if (unresolved.length > 0) ticker.finalize();

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

  console.log(`  LSP: Finding references for ${symbols.length} exported symbols`);

  const referenceLinks: SymbolLink[] = [];
  const concurrency = 10;
  let nextIndex = 0;
  const ticker = makeTicker(symbols.length, "LSP refs", verbose);

  async function worker() {
    while (nextIndex < symbols.length) {
      const idx = nextIndex++;
      const sym = symbols[idx]!;
      const client = manager.getClientForLanguage(sym.language);
      if (!client || !client.supportsReferences) {
        ticker.tick();
        continue;
      }

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
            confidence: "INFERRED",
          });
        }
      } catch {
        // Individual request failed — skip silently
      } finally {
        ticker.tick();
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, symbols.length) },
    () => worker(),
  );
  await Promise.all(workers);
  if (symbols.length > 0) ticker.finalize();

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
  // Keep the highest-confidence entry per key so an AST-EXTRACTED link is never
  // silently overwritten by an LSP-INFERRED duplicate that happened to arrive later.
  const seen = new Map<string, number>();
  const deduped: SymbolLink[] = [];

  for (const link of links) {
    const key = `${link.sourceFile}::${link.sourceSymbol}::${link.targetFile}::${link.targetSymbol}::${link.callName}`;
    const existingIdx = seen.get(key);
    if (existingIdx === undefined) {
      seen.set(key, deduped.length);
      deduped.push(link);
    } else {
      const existing = deduped[existingIdx]!;
      const existingRank = existing.confidence ? CONFIDENCE_RANK[existing.confidence] : 0;
      const newRank = link.confidence ? CONFIDENCE_RANK[link.confidence] : 0;
      if (newRank > existingRank) deduped[existingIdx] = link;
    }
  }

  return deduped;
}

/**
 * Redirect an LSP-resolved link from an interface method (or from the field
 * declaration that exposes an interface-typed dependency) to the concrete
 * implementing class's method, when there is exactly one implementation.
 *
 * Two failure modes we correct here:
 *  1. LSP "go to definition" landed on the interface method itself.
 *  2. LSP landed on the field/property declaration (e.g. `private IFoo _foo;`)
 *     because the call expression resolves to a member access — useless for
 *     a call-graph reader.
 */
function redirectThroughInterface(
  link: SymbolLink,
  analyses: FileAnalysis[],
  ifaceMap: Map<string, InterfaceImplInfo>,
): SymbolLink {
  // Leaf method name from the call expression: "_foo.Bar.Baz" → "Baz".
  const parts = link.callName.split(".");
  const leaf = parts[parts.length - 1]!;
  const prefix = parts.length > 1 ? parts.slice(0, -1).join(".") : null;

  // Case 1: target is an interface file whose interface contains this method.
  for (const iface of ifaceMap.values()) {
    if (iface.interfaceFile !== link.targetFile) continue;
    const hasMethod = iface.methods.some((m) => m.name === leaf);
    if (!hasMethod) continue;
    if (iface.impls.length === 1) {
      const impl = iface.impls[0]!;
      const implMethod = impl.methods.get(leaf);
      if (implMethod) {
        return {
          ...link,
          targetFile: impl.classFile,
          targetSymbol: `${impl.className}.${leaf}`,
          targetLine: implMethod.line,
        };
      }
    }
    return link; // multiple impls → leave on interface (fanout edges handle navigation)
  }

  // Case 2: target is a field/property declaration. We detect this by checking
  // whether the source class in `link.sourceFile` has a property named `prefix`
  // with an interface type — and the LSP target sits inside that class but does
  // not match any of its methods. In that case route through the interface map.
  if (!prefix) return link;
  const sourceAnalysis = analyses.find((a) => a.filePath === link.sourceFile);
  if (!sourceAnalysis) return link;

  const trimmedPrefix = prefix.replace(/^this\./, "");
  let propertyType: string | null = null;
  for (const cls of sourceAnalysis.classes) {
    const prop = cls.properties.find((p) => p.name === trimmedPrefix);
    if (prop?.type) { propertyType = prop.type.replace(/[?*&]/g, "").trim(); break; }
    const ctor = cls.methods.find((m) => m.name === "constructor" || m.name === "__init__" || m.name === "__construct");
    const ctorParam = ctor?.params.find((p) => p.name === trimmedPrefix);
    if (ctorParam?.type) { propertyType = ctorParam.type.replace(/[?*&]/g, "").trim(); break; }
  }
  if (!propertyType) return link;

  const iface = ifaceMap.get(propertyType);
  if (!iface) return link;
  if (iface.impls.length !== 1) {
    // Re-aim at the interface method instead of the field — at least gives the
    // reader a navigable signature. Fanout from the interface fills in impls.
    const ifaceMethod = iface.methods.find((m) => m.name === leaf);
    if (ifaceMethod) {
      return {
        ...link,
        targetFile: iface.interfaceFile,
        targetSymbol: `${iface.interfaceName}.${leaf}`,
        targetLine: ifaceMethod.line,
      };
    }
    return link;
  }
  const impl = iface.impls[0]!;
  const implMethod = impl.methods.get(leaf);
  if (!implMethod) return link;
  return {
    ...link,
    targetFile: impl.classFile,
    targetSymbol: `${impl.className}.${leaf}`,
    targetLine: implMethod.line,
  };
}
