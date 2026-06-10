import type { FileAnalysis, SymbolLink, CallInfo, Confidence } from "../types/analysis.js";
import { resolveTarget, buildFilePathMap } from "../extractors/shared/link-scoring.js";
import { BEST_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";

interface SymbolDef {
  name: string;
  line: number;
  endLine: number;
}

/**
 * Build a cross-file symbol link table that maps every resolvable call
 * to the function/method definition it targets.
 *
 * Runs as a post-analysis pass after all files have been individually analyzed.
 */
export function buildSymbolLinks(analyses: FileAnalysis[]): SymbolLink[] {
  const filePathMap = buildFilePathMap(analyses);
  const symbolIndex = buildSymbolIndex(analyses);
  const inheritanceMap = buildInheritanceMap(analyses);
  const injectionMap = buildInjectionMap(analyses);
  const interfaceImplMap = buildInterfaceImplMap(analyses);
  const links: SymbolLink[] = [];

  for (const analysis of analyses) {
    const sourceFile = analysis.filePath;

    // Functions
    for (const fn of analysis.functions) {
      for (const call of fn.calls) {
        const link = resolveCallToDefinition(
          sourceFile, fn.name, call, analysis, filePathMap, symbolIndex, inheritanceMap, injectionMap, interfaceImplMap,
        );
        if (link) links.push(link);
      }
    }

    // Class methods
    for (const cls of analysis.classes) {
      for (const method of cls.methods) {
        const sourceSymbol = `${cls.name}.${method.name}`;
        for (const call of method.calls) {
          const link = resolveCallToDefinition(
            sourceFile, sourceSymbol, call, analysis, filePathMap, symbolIndex, inheritanceMap, injectionMap, interfaceImplMap,
          );
          if (link) links.push(link);
        }
      }
    }

    // Route handlers
    for (const route of analysis.routes) {
      const sourceSymbol = `route:${route.httpMethod ?? "USE"} ${route.path}`;

      // Link route → its handler method (e.g., route:GET /api/users → getAllUsers)
      if (route.handler) {
        // Extract the method name from qualified handlers like "h.ListUsers" or "UsersController#index"
        const handlerName = route.handler.includes("#")
          ? route.handler.split("#").pop()!
          : route.handler.includes(".")
            ? route.handler.split(".").pop()!
            : route.handler;

        const handlerLink = resolveCallToDefinition(
          sourceFile, sourceSymbol,
          { name: route.handler, kind: "internal", target: null, line: route.line },
          analysis, filePathMap, symbolIndex, inheritanceMap, injectionMap, interfaceImplMap,
        );
        if (handlerLink) {
          links.push(handlerLink);
        } else {
          // Fallback: search all files for the handler name — best-effort, no import proof.
          for (const [filePath, syms] of symbolIndex) {
            const def = syms.get(handlerName);
            if (def) {
              links.push({
                sourceFile,
                sourceSymbol,
                sourceLine: route.line,
                callName: route.handler,
                targetFile: filePath,
                targetSymbol: def.name,
                targetLine: def.line,
                confidence: "AMBIGUOUS",
              });
              break;
            }
          }
        }
      }

      // Link route → functions it calls
      for (const call of route.calls) {
        const link = resolveCallToDefinition(
          sourceFile, sourceSymbol, call, analysis, filePathMap, symbolIndex, inheritanceMap, injectionMap, interfaceImplMap,
        );
        if (link) links.push(link);
      }
    }

    // Data source callbacks (lifecycle hooks, watchers)
    for (const ds of analysis.dataSources) {
      for (const call of ds.calls) {
        const link = resolveCallToDefinition(
          sourceFile, ds.name, call, analysis, filePathMap, symbolIndex, inheritanceMap, injectionMap, interfaceImplMap,
        );
        if (link) links.push(link);
      }
    }
  }

  // Fan-out: for interfaces with >1 implementations, emit a link from each
  // interface method to every implementation's matching method so the trace
  // tab can navigate from interface → all impls. (Single-impl interfaces are
  // already redirected directly at the call site in resolveCallToDefinition.)
  for (const [, info] of interfaceImplMap) {
    if (info.impls.length < 2) continue;
    for (const ifaceMethod of info.methods) {
      const ifaceSymbol = `${info.interfaceName}.${ifaceMethod.name}`;
      for (const impl of info.impls) {
        const implMethod = impl.methods.get(ifaceMethod.name);
        if (!implMethod) continue;
        links.push({
          sourceFile: info.interfaceFile,
          sourceSymbol: ifaceSymbol,
          sourceLine: ifaceMethod.line,
          callName: ifaceMethod.name,
          targetFile: impl.classFile,
          targetSymbol: `${impl.className}.${ifaceMethod.name}`,
          targetLine: implMethod.line,
          confidence: "INFERRED",
        });
      }
    }
  }

  // Phase B: Reverse reference scanning — find which files import each exported symbol
  const reverseLinks = buildReverseReferenceLinks(analyses, filePathMap, symbolIndex);
  links.push(...reverseLinks);

  // Deduplicate links (same source→target with same call can appear from handler + calls).
  // Keep the highest-confidence entry per key — a directly-extracted match should win
  // over a fallback heuristic that happened to fire first.
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
 * Build a per-file symbol index from all analyses.
 * Maps filePath → Map<symbolName → SymbolDef>
 */
function buildSymbolIndex(
  analyses: FileAnalysis[],
): Map<string, Map<string, SymbolDef>> {
  const index = new Map<string, Map<string, SymbolDef>>();

  for (const analysis of analyses) {
    const fileSymbols = new Map<string, SymbolDef>();

    // Functions
    for (const fn of analysis.functions) {
      fileSymbols.set(fn.name, {
        name: fn.name,
        line: fn.line,
        endLine: fn.endLine,
      });
    }

    // Class methods (store both qualified and unqualified names)
    for (const cls of analysis.classes) {
      // The class itself
      fileSymbols.set(cls.name, {
        name: cls.name,
        line: cls.line,
        endLine: cls.endLine,
      });

      for (const method of cls.methods) {
        const qualified = `${cls.name}.${method.name}`;
        fileSymbols.set(qualified, {
          name: qualified,
          line: method.line,
          endLine: method.endLine,
        });
        // Also store unqualified as fallback (if not already taken by a function)
        if (!fileSymbols.has(method.name)) {
          fileSymbols.set(method.name, {
            name: qualified,
            line: method.line,
            endLine: method.endLine,
          });
        }
      }
    }

    // Exports (fill in symbols not already captured by functions/methods)
    for (const exp of analysis.exports) {
      if (!fileSymbols.has(exp.name)) {
        fileSymbols.set(exp.name, {
          name: exp.name,
          line: exp.line,
          endLine: exp.line,
        });
      }
    }

    index.set(analysis.filePath, fileSymbols);
  }

  return index;
}

/**
 * Build an inheritance map: className → { parentClass, parentFile }
 * Used to resolve inherited method calls.
 */
function buildInheritanceMap(
  analyses: FileAnalysis[],
): Map<string, { parentClass: string; parentFile: string }> {
  const classToFile = new Map<string, string>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      classToFile.set(cls.name, a.filePath);
    }
  }

  const map = new Map<string, { parentClass: string; parentFile: string }>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.extends) {
        const parentFile = classToFile.get(cls.extends);
        if (parentFile) {
          map.set(cls.name, { parentClass: cls.extends, parentFile });
        }
      }
    }
  }
  return map;
}

/**
 * Build a dependency injection map: for each class, track constructor-param
 * types so we can resolve `this.service.method()` calls.
 * Maps: filePath::paramName → { typeName, typeFile }
 */
function buildInjectionMap(
  analyses: FileAnalysis[],
): Map<string, { typeName: string; typeFile: string }> {
  // Build class → file lookup
  const classToFile = new Map<string, string>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      classToFile.set(cls.name, a.filePath);
    }
  }

  const map = new Map<string, { typeName: string; typeFile: string }>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      // Check constructor params for typed dependencies (various language conventions)
      const ctor = cls.methods.find((m) =>
        m.name === "constructor" || m.name === "__init__" ||
        m.name === "__construct" || m.name === "New" || m.name === "new",
      );
      if (ctor) {
        for (const param of ctor.params) {
          if (param.type) {
            const typeName = param.type.replace(/[?*&]/, "").trim();
            const typeFile = classToFile.get(typeName);
            if (typeFile) {
              // Map both the param name and camelCase variants
              const key = `${a.filePath}::${param.name}`;
              map.set(key, { typeName, typeFile });
              // Also map with "this." prefix for PHP/TS ($this->service, this.service)
              map.set(`${a.filePath}::this.${param.name}`, { typeName, typeFile });
            }
          }
        }
      }

      // Also check class properties with known types
      for (const prop of cls.properties) {
        if (prop.type) {
          const typeName = prop.type.replace(/[?*&]/, "").trim();
          const typeFile = classToFile.get(typeName);
          if (typeFile) {
            map.set(`${a.filePath}::${prop.name}`, { typeName, typeFile });
            map.set(`${a.filePath}::this.${prop.name}`, { typeName, typeFile });
          }
        }
      }
    }
  }
  return map;
}

/**
 * Build an interface→implementations map keyed by interface name.
 * Used to route calls made through an interface-typed dependency to the
 * concrete implementing class (when there's a single one) or to fan out
 * trace edges from the interface to all implementations (when there are many).
 */
export function buildInterfaceImplMap(
  analyses: FileAnalysis[],
): Map<string, InterfaceImplInfo> {
  const map = new Map<string, InterfaceImplInfo>();

  // Seed entries for every interface we know about.
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.kind === "interface") {
        map.set(cls.name, {
          interfaceName: cls.name,
          interfaceFile: a.filePath,
          methods: cls.methods.map((m) => ({ name: m.name, line: m.line })),
          impls: [],
        });
      }
    }
  }

  // Attach implementing classes. Inspect both `implements` and `extends`:
  // some languages (notably C#) can't syntactically distinguish a class base
  // from an interface base, so an interface may appear as `extends` here.
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.kind === "interface") continue;
      const candidates = [...cls.implements];
      if (cls.extends) candidates.push(cls.extends);
      for (const ifaceName of candidates) {
        const entry = map.get(ifaceName);
        if (!entry) continue;
        const methods = new Map<string, { name: string; line: number }>();
        for (const m of cls.methods) {
          methods.set(m.name, { name: m.name, line: m.line });
        }
        entry.impls.push({
          className: cls.name,
          classFile: a.filePath,
          methods,
        });
      }
    }
  }

  return map;
}

/**
 * Try to resolve a single call to its definition site.
 * Returns a SymbolLink if resolution succeeds, null otherwise.
 */
export interface InterfaceImplInfo {
  interfaceName: string;
  interfaceFile: string;
  methods: { name: string; line: number }[];
  impls: {
    className: string;
    classFile: string;
    methods: Map<string, { name: string; line: number }>;
  }[];
}

function resolveCallToDefinition(
  sourceFile: string,
  sourceSymbol: string,
  call: CallInfo,
  analysis: FileAnalysis,
  filePathMap: Map<string, string>,
  symbolIndex: Map<string, Map<string, SymbolDef>>,
  inheritanceMap: Map<string, { parentClass: string; parentFile: string }>,
  injectionMap: Map<string, { typeName: string; typeFile: string }>,
  interfaceImplMap: Map<string, InterfaceImplInfo>,
): SymbolLink | null {
  // Skip API and database calls — they don't resolve to project symbols
  if (call.kind === "api-call" || call.kind === "database") return null;

  let targetFile: string | null;

  if (call.kind === "cross-file" && call.target) {
    // Resolve import source to actual file path
    targetFile = resolveTarget(call.target, sourceFile, filePathMap);
    if (!targetFile) return null;
  } else if (call.kind === "internal") {
    // Internal calls resolve within the same file
    targetFile = sourceFile;
  } else {
    return null;
  }

  // Look up the symbol in the target file
  const fileSymbols = symbolIndex.get(targetFile);
  if (!fileSymbols) return null;

  // Extract leaf name: "userStore.fetchUsers" → "fetchUsers"
  const isQualified = call.name.includes(".");
  const leafName = isQualified ? call.name.split(".").pop()! : call.name;

  // Try exact call name first. For unqualified calls, fall back to the leaf name —
  // this resolves cases like route handlers that reference a method by bare name.
  // For qualified calls, we deliberately DON'T fall back to leaf-name lookup here:
  // a qualified call like `_http.PostAsync` should only resolve when the prefix
  // is known (via injection tracking, inheritance, or ClassName.method patterns).
  // Same-file leaf matching for qualified calls causes false self-links.
  let def = fileSymbols.get(call.name);
  if (!def && !isQualified) {
    def = fileSymbols.get(leafName);
  }
  // `self.foo` / `Self.foo` / `this.foo` — strip the receiver and look up the
  // leaf in the current file. Safe for internal calls because the receiver is
  // unambiguous; for cross-file calls we rely on injection tracking.
  if (!def && isQualified && call.kind === "internal" && targetFile === sourceFile) {
    const head = call.name.split(".")[0]!;
    if (head === "self" || head === "Self" || head === "this") {
      def = fileSymbols.get(leafName);
    }
  }

  // ── Strategy 1: Inheritance resolution ──
  // If not found in current file and call is internal, walk up the class hierarchy.
  // Inherited methods are not explicitly named at the call site — INFERRED.
  if (!def && call.kind === "internal") {
    const currentClasses = analysis.classes;
    for (const cls of currentClasses) {
      let parentInfo = inheritanceMap.get(cls.name);
      const visited = new Set<string>();
      while (parentInfo && !visited.has(parentInfo.parentClass)) {
        visited.add(parentInfo.parentClass);
        const parentSymbols = symbolIndex.get(parentInfo.parentFile);
        if (parentSymbols) {
          const parentDef = parentSymbols.get(leafName)
            ?? parentSymbols.get(`${parentInfo.parentClass}.${leafName}`);
          if (parentDef) {
            return {
              sourceFile,
              sourceSymbol,
              sourceLine: call.line,
              callName: call.name,
              targetFile: parentInfo.parentFile,
              targetSymbol: parentDef.name,
              targetLine: parentDef.line,
              confidence: "INFERRED",
            };
          }
        }
        // Walk further up the chain
        parentInfo = inheritanceMap.get(parentInfo.parentClass);
      }
    }
  }

  // ── Strategy 2: Dependency injection resolution ──
  // For qualified calls like "this.authService.authenticate" — resolved via the
  // declared parameter/property type, not via an explicit import of the method.
  if (!def && call.name.includes(".")) {
    const parts = call.name.split(".");
    // Try various prefixes: "this.authService", "authService", "self.service"
    for (let segLen = 1; segLen < parts.length; segLen++) {
      const prefix = parts.slice(0, segLen).join(".");
      const methodName = parts.slice(segLen).join(".");
      const injKey = `${sourceFile}::${prefix}`;
      const injection = injectionMap.get(injKey);
      if (injection) {
        // If the declared type is an interface with exactly one implementation,
        // skip the interface and link straight to the implementation's method.
        const iface = interfaceImplMap.get(injection.typeName);
        if (iface && iface.impls.length === 1) {
          const impl = iface.impls[0]!;
          const implMethod = impl.methods.get(methodName)
            ?? impl.methods.get(parts[parts.length - 1]);
          if (implMethod) {
            return {
              sourceFile,
              sourceSymbol,
              sourceLine: call.line,
              callName: call.name,
              targetFile: impl.classFile,
              targetSymbol: `${impl.className}.${implMethod.name}`,
              targetLine: implMethod.line,
              confidence: "INFERRED",
            };
          }
        }

        const typeSymbols = symbolIndex.get(injection.typeFile);
        if (typeSymbols) {
          const injDef = typeSymbols.get(methodName)
            ?? typeSymbols.get(`${injection.typeName}.${methodName}`)
            ?? typeSymbols.get(parts[parts.length - 1]);
          if (injDef) {
            return {
              sourceFile,
              sourceSymbol,
              sourceLine: call.line,
              callName: call.name,
              targetFile: injection.typeFile,
              targetSymbol: injDef.name,
              targetLine: injDef.line,
              confidence: "INFERRED",
            };
          }
        }
      }
    }
  }

  // ── Strategy 3: Deep qualified call resolution ──
  // For calls like "prisma.user.findMany" where "prisma" is imported from another file
  if (!def && call.kind === "cross-file" && call.name.includes(".") && targetFile) {
    const targetSymbols = symbolIndex.get(targetFile);
    if (targetSymbols) {
      // Try matching any suffix of the qualified name
      const parts = call.name.split(".");
      for (let i = 1; i < parts.length; i++) {
        const suffix = parts.slice(i).join(".");
        const suffixDef = targetSymbols.get(suffix) ?? targetSymbols.get(parts[parts.length - 1]);
        if (suffixDef) {
          def = suffixDef;
          break;
        }
      }
    }
  }

  // ── Strategy 4: ClassName.method resolution for static/class methods ──
  // For calls like "UserService.find_by_id" — searches all files for the class.
  // Without an explicit import this is at best INFERRED.
  if (!def && call.name.includes(".")) {
    const parts = call.name.split(".");
    const className = parts[0];
    const methodName = parts.slice(1).join(".");

    // Find which file defines this class
    for (const [filePath, syms] of symbolIndex) {
      if (syms.has(className)) {
        const classDef = syms.get(`${className}.${methodName}`) ?? syms.get(methodName);
        if (classDef) {
          return {
            sourceFile,
            sourceSymbol,
            sourceLine: call.line,
            callName: call.name,
            targetFile: filePath,
            targetSymbol: classDef.name,
            targetLine: classDef.line,
            confidence: "INFERRED",
          };
        }
      }
    }
  }

  if (!def) return null;

  // Default path: a definition matched by exact name in the resolved target file.
  // For cross-file calls the confidence inherits from the call's import-side classification;
  // for same-file internal calls the symbol is directly visible — EXTRACTED.
  const linkConfidence: Confidence | undefined =
    call.kind === "cross-file"
      ? call.confidence
      : (call.kind === "internal" ? "EXTRACTED" : undefined);

  const link: SymbolLink = {
    sourceFile,
    sourceSymbol,
    sourceLine: call.line,
    callName: call.name,
    targetFile,
    targetSymbol: def.name,
    targetLine: def.line,
  };
  if (linkConfidence) link.confidence = linkConfidence;
  return link;
}

/**
 * Build reverse reference links: for each exported symbol, find all files
 * that import it and create a reference link.
 */
function buildReverseReferenceLinks(
  analyses: FileAnalysis[],
  filePathMap: Map<string, string>,
  symbolIndex: Map<string, Map<string, SymbolDef>>,
): SymbolLink[] {
  const links: SymbolLink[] = [];

  // Build import usage: for each file, which specifiers are imported from which sources
  for (const analysis of analyses) {
    for (const imp of analysis.imports) {
      if (imp.isType) continue;

      const targetFile = resolveTarget(imp.source, analysis.filePath, filePathMap);
      if (!targetFile || targetFile === analysis.filePath) continue;

      const targetSymbols = symbolIndex.get(targetFile);
      if (!targetSymbols) continue;

      for (const spec of imp.specifiers) {
        const def = targetSymbols.get(spec);
        if (def) {
          // Reference reverse-link: an explicit import with matching named specifier.
          links.push({
            sourceFile: analysis.filePath,
            sourceSymbol: "(reference)",
            sourceLine: imp.line,
            callName: spec,
            targetFile,
            targetSymbol: def.name,
            targetLine: def.line,
            confidence: "EXTRACTED",
          });
        }
      }
    }
  }

  return links;
}
