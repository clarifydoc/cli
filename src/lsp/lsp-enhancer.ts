import { readFile } from "fs/promises";
import { join } from "path";
import type {
  FileAnalysis,
  SymbolLink,
  CallInfo,
  Language,
  LspStats,
  LspDefinitionRecord,
  LspReferenceRecord,
} from "../types/analysis.js";
import { BEST_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";
import type { DiscoveredFile } from "../core/file-discovery.js";
import { LspManager } from "./lsp-manager.js";
import { buildInterfaceImplMap, closestByDir, type InterfaceImplInfo } from "../core/symbol-linker.js";

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
  /** Every definition query made and its raw answer — the ground truth the text linker can be optimized against. */
  definitionRecords: LspDefinitionRecord[];
  /** Every reference query made and the non-self references found. */
  referenceRecords: LspReferenceRecord[];
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
 * Lazy per-file source line cache. Queries must target the *identifier* token
 * (LSP answers "what is the symbol at this exact position"), and extractor
 * columns point at the start of the call expression — so we re-read the source
 * to locate the leaf token. Promise-cached so concurrent workers share reads.
 */
class SourceLineCache {
  private cache = new Map<string, Promise<string[] | null>>();

  constructor(private projectRoot: string) {}

  getLine(relPath: string, line: number): Promise<string | null> {
    let p = this.cache.get(relPath);
    if (!p) {
      p = readFile(join(this.projectRoot, relPath), "utf-8").then(
        (text) => text.split(/\r?\n/),
        () => null,
      );
      this.cache.set(relPath, p);
    }
    return p.then((lines) => (lines ? lines[line - 1] ?? null : null));
  }
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * The token the query should land on: the called member, not its receiver.
 * "svc.ListUsers" → "ListUsers", "$this->save" → "save", "Config::load" →
 * "load", "new AuthResponse" → "AuthResponse", "useThing" → "useThing".
 */
function leafToken(callName: string): string {
  const segments = callName.split(/\.|->|::/);
  let leaf = segments[segments.length - 1]!;
  // `AddScoped<IUserService, UserService>` — the invoked token is the method
  // name, not the generic argument list.
  const generic = leaf.indexOf("<");
  if (generic > 0) leaf = leaf.slice(0, generic);
  const lastSpace = leaf.lastIndexOf(" ");
  if (lastSpace >= 0) leaf = leaf.slice(lastSpace + 1);
  return leaf;
}

/**
 * Column of `token` as a whole identifier at/after `fromCol` in `text`,
 * retrying from the line start when extractor columns are off; null if the
 * token isn't on this line.
 */
function findTokenColumn(text: string, token: string, fromCol: number): number | null {
  if (!token) return null;
  const search = (start: number): number | null => {
    let idx = text.indexOf(token, start);
    while (idx !== -1) {
      const before = idx > 0 ? text[idx - 1]! : "";
      const after = text[idx + token.length] ?? "";
      if (!IDENT_CHAR.test(before) && !IDENT_CHAR.test(after)) return idx;
      idx = text.indexOf(token, idx + 1);
    }
    return null;
  };
  const clamped = Math.max(0, Math.min(fromCol, text.length));
  const found = search(clamped);
  if (found !== null) return found;
  return clamped > 0 ? search(0) : null;
}

/**
 * Locate the leaf identifier of a call, scanning a few lines below the call
 * line to handle multi-line chains (`builder\n  .build()`). Falls back to the
 * extractor-reported position when the token can't be found.
 */
async function findQueryPosition(
  sourceLines: SourceLineCache,
  filePath: string,
  call: CallInfo,
): Promise<{ line: number; column: number }> {
  const fallback = { line: call.line, column: call.column ?? 0 };
  const leaf = leafToken(call.name);
  if (!leaf) return fallback;

  const MULTILINE_WINDOW = 5;
  for (let offset = 0; offset < MULTILINE_WINDOW; offset++) {
    const text = await sourceLines.getLine(filePath, call.line + offset);
    if (text === null) break;
    const col = findTokenColumn(text, leaf, offset === 0 ? fallback.column : 0);
    if (col !== null) return { line: call.line + offset, column: col };
  }
  return fallback;
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
        definitionRecords: [],
        referenceRecords: [],
      };
    }

    console.log(`  LSP servers started: ${serversUsed.join(", ")}`);

    const sourceLines = new SourceLineCache(projectRoot);

    // Phase A: Resolve unresolved calls. Records keep every query + raw answer
    // (including misses) so the run can be exported as ground truth.
    const definitionRecords = await resolveUnresolvedCalls(
      analyses, existingLinks, manager, sourceLines, verbose,
    );

    // Derive links from the resolved records, keeping each link paired with
    // its record so the interface redirect below can annotate the right one.
    const resolved: { rec: LspDefinitionRecord; link: SymbolLink }[] = [];
    for (const rec of definitionRecords) {
      if (!rec.target) continue;
      resolved.push({
        rec,
        link: {
          sourceFile: rec.sourceFile,
          sourceSymbol: rec.sourceSymbol,
          sourceLine: rec.line,
          callName: rec.callName,
          targetFile: rec.target.file,
          targetSymbol: rec.callName,
          targetLine: rec.target.line,
          resolvedBy: "lsp",
          confidence: "INFERRED",
          strategy: "lsp-definition",
          relation: "calls",
        },
      });
    }
    const definitionLinks = resolved.map((p) => p.link);
    const resolvedCount = definitionLinks.length;

    // Phase B: Find references for exported symbols
    const { referenceLinks, referenceRecords } = await findReferences(
      analyses, existingLinks, definitionLinks, manager, sourceLines, verbose,
    );

    // Redirect LSP-resolved interface/field targets to the concrete implementation
    // when there's exactly one. C# OmniSharp's textDocument/definition for a call
    // like `_userService.CreateAsync()` often lands on the interface method or the
    // field declaration — neither of which is what a reader navigating a call graph
    // wants. We rewrite those to the implementing class's method.
    const ifaceMap = buildInterfaceImplMap(analyses);
    const redirectedDefinitions = resolved.map(({ rec, link }) => {
      const redirected = redirectThroughInterface(link, analyses, ifaceMap);
      if (
        redirected.targetFile !== link.targetFile ||
        redirected.targetSymbol !== link.targetSymbol ||
        redirected.targetLine !== link.targetLine
      ) {
        rec.redirectedTarget = {
          file: redirected.targetFile,
          symbol: redirected.targetSymbol,
          line: redirected.targetLine,
        };
      }
      return redirected;
    });

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
      definitionRecords,
      referenceRecords,
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
  sourceLines: SourceLineCache,
  verbose: boolean,
): Promise<LspDefinitionRecord[]> {
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

  // Query LSP for each unresolved call (with concurrency limit). Records are
  // written by input index so the output order is deterministic regardless of
  // worker completion order. Only queried calls get a record — calls for
  // languages with no running server are skipped, not recorded as misses.
  const records: (LspDefinitionRecord | undefined)[] = new Array(unresolved.length);

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

      // Aim the query at the LEAF identifier (`svc.ListUsers` → `ListUsers`):
      // at the expression's start column servers resolve the RECEIVER token and
      // answer with its field/param/import declaration instead of the method.
      const pos = await findQueryPosition(sourceLines, item.sourceFile, item.call);

      const record: LspDefinitionRecord = {
        sourceFile: item.sourceFile,
        sourceSymbol: item.sourceSymbol,
        line: item.call.line,
        column: pos.column,
        callName: item.call.name,
        callKind: item.call.kind,
        language: item.language,
        target: null,
      };
      records[idx] = record;

      try {
        // LSP uses 0-based lines, our positions are 1-based
        const definitions = await client.getDefinition(
          item.sourceFile,
          pos.line - 1,
          pos.column,
        );

        if (definitions.length > 0) {
          const def = definitions[0]!;
          record.target = { file: def.uri, line: def.line + 1 }; // back to 1-based
        } else if (process.env.CLARIFYDOC_LSP_DEBUG) {
          console.error(`  [lsp-debug] def EMPTY ${item.sourceFile}:${pos.line}:${pos.column} ${item.call.name}`);
        }
      } catch (err) {
        // Individual request failed — recorded as unresolved
        if (process.env.CLARIFYDOC_LSP_DEBUG) {
          console.error(`  [lsp-debug] def FAIL ${item.sourceFile}:${pos.line}:${pos.column} ${item.call.name}: ${(err as Error).message}`);
        }
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

  return records.filter((r): r is LspDefinitionRecord => r !== undefined);
}

// ─── Phase B: Find references ───────────────────────────────────────────

async function findReferences(
  analyses: FileAnalysis[],
  existingLinks: SymbolLink[],
  definitionLinks: SymbolLink[],
  manager: LspManager,
  sourceLines: SourceLineCache,
  verbose: boolean,
): Promise<{ referenceLinks: SymbolLink[]; referenceRecords: LspReferenceRecord[] }> {
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
  // Records by input index for deterministic output order (see resolveUnresolvedCalls).
  // Unlike links, records keep ALL non-self references — even ones already known
  // from text links — so the export reflects the full LSP answer.
  const records: (LspReferenceRecord | undefined)[] = new Array(symbols.length);
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

      const record: LspReferenceRecord = {
        symbolFile: sym.filePath,
        symbolName: sym.name,
        symbolLine: sym.line,
        language: sym.language,
        references: [],
      };
      records[idx] = record;

      // Column 0 of a declaration line is a keyword (`func`, `export`,
      // `public`) — most servers answer nothing there. Find the symbol's
      // name token on its declaration line and query that position.
      const leaf = leafToken(sym.name);
      let refCol = 0;
      const declText = await sourceLines.getLine(sym.filePath, sym.line);
      if (declText) {
        const col = findTokenColumn(declText, leaf, 0);
        if (col !== null) refCol = col;
      }

      try {
        const refs = await client.getReferences(
          sym.filePath,
          sym.line - 1, // 0-based
          refCol,
        );

        for (const ref of refs) {
          // Skip self-references
          if (ref.uri === sym.filePath && ref.line + 1 === sym.line) continue;

          record.references.push({ file: ref.uri, line: ref.line + 1 });

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
            strategy: "lsp-reference",
            relation: "reference",
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

  return {
    referenceLinks,
    referenceRecords: records.filter((r): r is LspReferenceRecord => r !== undefined),
  };
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
/**
 * Re-aim a link that landed on an interface so it points at the implementation.
 *
 * Every return here restates `strategy`: the link keeps its identity but not its
 * provenance, because what resolved the FINAL target was this interface/impl
 * step, not whatever first created the link. A spread that carried the old tag
 * through would be quietly wrong in the artifact.
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
          strategy: "interface-redirect",
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

  // The map holds one entry per interface DEFINITION; a name defined in
  // several packages means the one closest to the caller.
  const named = [...ifaceMap.values()].filter((i) => i.interfaceName === propertyType);
  const iface = named.length <= 1 ? named[0] : closestByDir(named, link.sourceFile, (i) => i.interfaceFile);
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
        strategy: "interface-redirect",
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
    strategy: "interface-redirect",
  };
}
