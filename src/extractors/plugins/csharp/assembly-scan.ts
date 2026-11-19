import type { ClassInfo, FileAnalysis, FunctionInfo, Language, RouteFact, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * Handlers a framework registers by SCANNING an assembly. Nothing calls them:
 * the container finds every class implementing the handler interface in the
 * assembly (a .NET assembly is one C# project) the registration names, so the
 * generic linker sees a `Handle` method no one calls. The registering file
 * states the scan as a `cs:assembly-scan` fact; `CSharpAssemblyScanResolver`
 * joins it to the handler classes of the scanned project as
 * `registering function → Handler.Handle` links.
 *
 *   MediatR        `AddMediatR(cfg => cfg.RegisterServicesFromAssembly(typeof(X).Assembly))`,
 *                  `AddMediatR(typeof(X))`, the `Mediator` source generator's `AddMediator()`
 *   MassTransit    `x.AddConsumers(typeof(X).Assembly)`, `AddConsumersFromNamespaceContaining<X>()`
 *   NServiceBus    `new EndpointConfiguration("club")` — the project's `IHandleMessages<T>` classes
 *
 * A scan that names no type (`AddMediator()`, `Assembly.GetExecutingAssembly()`,
 * `AddConsumers()`) scans the registering project itself.
 */
export const CS_ASSEMBLY_SCAN_FACT = "cs:assembly-scan";

interface ScanFamily {
  id: string;
  /** What the scan's registering call is named. */
  call: RegExp;
  /** The interface a scanned class implements to be picked up. */
  handlerInterface: RegExp;
  methods: ReadonlySet<string>;
  /** `Foo<X>()`-style generic marker calls. */
  genericMarkers: RegExp | null;
  /** The call limits the scan to the namespace of its marker. */
  namespaceScoped?: RegExp;
}

const FAMILIES: ScanFamily[] = [
  {
    id: "mediatr",
    call: /\b(?:AddMediatR|AddMediator)\b/g,
    handlerInterface: /\bI(?:Request|Notification|StreamRequest)Handler\s*</,
    methods: new Set(["Handle", "HandleAsync"]),
    genericMarkers: /\bRegisterServicesFromAssemblyContaining\s*<\s*([\w.]+)\s*>/g,
  },
  {
    id: "masstransit",
    call: /\b(?:AddConsumers|AddConsumersFromNamespaceContaining)\b/g,
    handlerInterface: /\bIConsumer\s*</,
    methods: new Set(["Consume"]),
    genericMarkers: /\bAddConsumersFromNamespaceContaining\s*<\s*([\w.]+)\s*>/g,
    namespaceScoped: /\bAddConsumersFromNamespaceContaining\b/,
  },
  {
    id: "nservicebus",
    call: /\bnew\s+EndpointConfiguration\b/g,
    handlerInterface: /\bIHandleMessages\s*</,
    methods: new Set(["Handle"]),
    genericMarkers: null,
  },
];

export interface AssemblyScanFact {
  family: string;
  /** Types whose assembly (project) is scanned; empty = the registering project. */
  markers: string[];
  /** Scan only the namespace of the marker (MassTransit `…FromNamespaceContaining`). */
  namespaceOnly: boolean;
}

/** Blank `//` and block comments, keeping offsets and lines. */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The text of the balanced `(…)` that starts at or after `from`, or "" when none. */
function balancedArgs(text: string, from: number): string {
  let i = from;
  // A generic argument list sits between the name and the parentheses.
  const gen = /^\s*<[^<>()]*>/.exec(text.slice(i));
  if (gen) i += gen[0].length;
  if (!/^\s*\(/.test(text.slice(i))) return "";
  i = text.indexOf("(", i);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return text.slice(i, j + 1);
  }
  return text.slice(i);
}

/** Facts for every assembly-scanning registration the file makes (`routeFacts`). */
export function collectAssemblyScans(sourceText: string, facts: RouteFact[]): void {
  if (!/AddMediatR|AddMediator|AddConsumers|EndpointConfiguration/.test(sourceText)) return;
  const text = blankComments(sourceText);
  for (const fam of FAMILIES) {
    for (const m of text.matchAll(fam.call)) {
      const start = m.index! + m[0].length;
      const args = balancedArgs(text, start);
      // `typeof(X).Assembly`, or the type as the call's own first argument (`AddMediatR(typeof(X))`);
      // not `cfg.AddBehavior(typeof(Audit))`, which names no assembly.
      const markers = [...args.matchAll(/\btypeof\s*\(\s*([\w.]+)\s*\)\s*\.\s*Assembly\b/g)].map((t) => t[1]!.split(".").pop()!);
      const direct = /^\(\s*typeof\s*\(\s*([\w.]+)\s*\)\s*[,)]/.exec(args);
      if (direct) markers.push(direct[1]!.split(".").pop()!);
      // `AddConsumersFromNamespaceContaining<X>()` / `RegisterServicesFromAssemblyContaining<X>()`.
      const generic = /^\s*<\s*([\w.]+)\s*>/.exec(text.slice(start));
      if (generic) markers.push(generic[1]!.split(".").pop()!);
      if (fam.genericMarkers) for (const g of args.matchAll(fam.genericMarkers)) markers.push(g[1]!.split(".").pop()!);
      const line = text.slice(0, m.index).split("\n").length;
      const data: AssemblyScanFact = {
        family: fam.id,
        markers: [...new Set(markers)],
        namespaceOnly: !!fam.namespaceScoped && fam.namespaceScoped.test(m[0]),
      };
      facts.push({ kind: CS_ASSEMBLY_SCAN_FACT, line, data });
    }
  }
}

/** The callable that contains `line`: innermost method or function, else the file's `<setup>`. */
function enclosing(a: FileAnalysis, line: number): { symbol: string; line: number } | null {
  let best: { symbol: string; line: number; span: number } | null = null;
  const consider = (symbol: string, fn: FunctionInfo): void => {
    const end = fn.endLine ?? fn.line;
    if (line < fn.line || line > end || fn.name === "<setup>") return;
    const span = end - fn.line;
    if (!best || span < best.span) best = { symbol, line: fn.line, span };
  };
  for (const fn of a.functions) consider(fn.name, fn);
  for (const cls of a.classes) for (const mth of cls.methods) consider(`${cls.name}.${mth.name}`, mth);
  if (best) return best;
  const setup = a.functions.find((f) => f.name === "<setup>");
  return setup ? { symbol: setup.name, line: setup.line } : null;
}

export class CSharpAssemblyScanResolver implements DispatchResolver {
  readonly id = "assembly-scan";
  readonly languages: Language[] = ["csharp"];
  readonly priority = 11;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const scans = analyses.filter((a) => a.routeFacts?.some((f) => f.kind === CS_ASSEMBLY_SCAN_FACT));
    if (scans.length === 0) return [];
    const declaring = new Map<string, FileAnalysis[]>();
    for (const a of analyses) for (const c of a.classes) (declaring.get(c.name) ?? declaring.set(c.name, []).get(c.name)!).push(a);

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const reg of scans) {
      for (const fact of reg.routeFacts!) {
        if (fact.kind !== CS_ASSEMBLY_SCAN_FACT) continue;
        const data = fact.data as AssemblyScanFact;
        const fam = FAMILIES.find((f) => f.id === data.family);
        const from = enclosing(reg, fact.line);
        if (!fam || !from) continue;
        // The scanned assemblies: the project of each marker type (the registering project's own
        // namesake first), or the registering project when none is named.
        const scanned: Array<{ project: string | undefined; namespace?: string }> = [];
        if (data.markers.length === 0) scanned.push({ project: reg.projectId });
        for (const marker of data.markers) {
          const owners = declaring.get(marker) ?? [];
          // Top-level statements make `Program` implicit: no file declares it, its project is the registering one.
          if (owners.length === 0 && marker === "Program") {
            scanned.push({ project: reg.projectId });
            continue;
          }
          const own = owners.filter((o) => o.projectId === reg.projectId);
          const pick = own.length > 0 ? own : owners;
          if (pick.length !== 1 && new Set(pick.map((o) => o.projectId)).size !== 1) continue;
          scanned.push({ project: pick[0]!.projectId, namespace: data.namespaceOnly ? pick[0]!.packageName : undefined });
        }
        for (const target of analyses) {
          if (target.classes.length === 0) continue;
          const hit = scanned.find((s) => s.project === target.projectId && (!s.namespace || (target.packageName ?? "") === s.namespace || (target.packageName ?? "").startsWith(s.namespace + ".")));
          if (!hit) continue;
          for (const cls of target.classes) {
            for (const method of handlerMethods(cls, fam)) {
              const key = `${reg.filePath}|${from.symbol}|${target.filePath}|${cls.name}.${method.name}|${method.line}`;
              if (seen.has(key)) continue;
              seen.add(key);
              links.push({
                sourceFile: reg.filePath,
                sourceSymbol: from.symbol,
                sourceLine: fact.line,
                callName: `scan(${fam.id})`,
                targetFile: target.filePath,
                targetSymbol: `${cls.name}.${method.name}`,
                targetLine: method.line,
                confidence: "INFERRED",
              });
            }
          }
        }
      }
    }
    return links;
  }
}

/** The handler methods (one per handled message type) of a class implementing the family's interface. */
function handlerMethods(cls: ClassInfo, fam: ScanFamily): FunctionInfo[] {
  if (cls.kind === "interface" || cls.abstract) return [];
  const bases = [cls.extends, ...(cls.implements ?? [])].filter(Boolean) as string[];
  if (!bases.some((b) => fam.handlerInterface.test(b))) return [];
  return cls.methods.filter((m) => fam.methods.has(m.name));
}

