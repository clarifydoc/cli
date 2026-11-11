import { readFile } from "fs/promises";
import { join } from "path";
import type { McpTool } from "../protocol.js";
import { byOrdinal } from "../../core/ordinal.js";
import type { ProjectAnalysis, SymbolLink } from "../../types/analysis.js";
import { symbolKey, type LoadedAnalysis } from "../store.js";
import { bulletList, joinLines, loc, numberArg, plural, requiredStringArg, stringArg } from "../format.js";
import { mustResolveFile, nearSymbols, requireAnalysis, type ToolContext } from "./context.js";
import { noResults } from "../empty.js";

/** Rows of a refusal shown, however many caused it. */
const REFUSED_LISTED = 15;
/** Pick-one rows shown when a name has several definitions. */
const DEFINITIONS_LISTED = 12;
/** Files whose imports and exports are read for the names around the symbol. */
const IMPORT_FILES_READ = 150;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Languages whose `#` starts a comment; elsewhere it is syntax (C# regions, JS private names, C directives). */
const HASH_COMMENT = /\.(py|rb|sh|bash|pl|pm|r|ex|exs|cr|jl|nim|yml|yaml|toml|ps1|raku|mojo)$/i;

interface Span {
  file: string;
  line: number;
  /** 1-based column of the name's first character. */
  col: number;
  /** 1-based column just past its last character. */
  end: number;
}

interface Refusal {
  where: string;
  why: string;
}

const leafOf = (symbol: string): string => symbol.split(/[.:#]+/).pop() ?? symbol;
/** The name a call is written with: its last identifier (`new Garage` → `Garage`, `car->start` → `start`). */
const calledName = (callName: string): string => (callName.match(/[A-Za-z0-9_$]+/g) ?? []).pop() ?? callName;
const isMemberName = (symbol: string): boolean => /[.:#]/.test(symbol);

/** The line with string literals and trailing comments blanked, same length, so columns still line up. */
function codeOnly(line: string, file: string): string {
  const blank = (m: string): string => " ".repeat(m.length);
  let out = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, blank);
  out = out.replace(/\/\*.*?\*\//g, blank).replace(/\/\/.*$/, blank);
  if (HASH_COMMENT.test(file)) out = out.replace(/#.*$/, blank);
  return out;
}

/** Every place `name` stands alone as an identifier in the code of the line (0-based start indexes). */
function identifierHits(text: string, name: string): number[] {
  const hits: number[] = [];
  const word = /[A-Za-z0-9_$]/;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    if (at > 0 && word.test(text[at - 1]!)) continue;
    if (word.test(text[at + name.length] ?? "")) continue;
    hits.push(at);
  }
  return hits;
}

/** The name in a string or comment of the line: a dynamic use, or prose, that a rename would miss. */
function textualHits(line: string, code: string, name: string): number {
  return identifierHits(line, name).length - identifierHits(code, name).length;
}

export class Sources {
  private readonly cache = new Map<string, string[] | null>();
  constructor(private readonly root: string) {}
  async lines(file: string): Promise<string[] | null> {
    if (!this.cache.has(file)) {
      try {
        this.cache.set(file, (await readFile(join(this.root, file), "utf-8")).replace(/^\uFEFF/, "").split(/\r?\n/));
      } catch {
        this.cache.set(file, null);
      }
    }
    return this.cache.get(file)!;
  }
}

/** The one place the name is written on that line, or why it is not exactly one. */
async function spanOn(sources: Sources, file: string, line: number, name: string): Promise<{ span?: Span; why?: string; inText: number }> {
  const lines = await sources.lines(file);
  const text = lines?.[line - 1];
  if (text === undefined) return { why: "the line cannot be read (the file changed or is gone since the analysis)", inText: 0 };
  const code = codeOnly(text, file);
  const hits = identifierHits(code, name);
  const inText = textualHits(text, code, name);
  if (hits.length === 0) return { why: `\`${name}\` is not written on that line as an identifier (a call split over lines, spelled another way, or a link that carries the line where its caller starts, such as a route handler, not the call)`, inText };
  if (hits.length > 1) return { why: `\`${name}\` is written ${hits.length} times on that line`, inText };
  return { span: { file, line, col: hits[0]! + 1, end: hits[0]! + 1 + name.length }, inText };
}

/** The links that say a route's handler is this symbol: the route's own line is the link's source, not a call. */
const REGISTRATION_STRATEGIES: ReadonlySet<string> = new Set(["route-component", "route-self", "route-scan", "route-override"]);
/** A route annotation (`@GetMapping`) this many lines above the method it marks is the method itself, not a registration. */
const ANNOTATION_REACH = 10;
/** Route registrations listed, however many there are. */
const REGISTRATIONS_LISTED = 40;

/**
 * Where a route's registration line spells the handler's name — in code or inside a string (`'clubs#index'`,
 * `to: "clubs#index"`, `only: [:index]`). Several spellings are told apart by what precedes the name (`#`, `.`,
 * `::`, `:`), which is how a handler is written after its class; still several, or none, is a refusal.
 */
export async function registrationSpan(sources: Sources, file: string, line: number, name: string): Promise<{ span?: Span; inString?: boolean; why?: string }> {
  const text = (await sources.lines(file))?.[line - 1];
  if (text === undefined) return { why: "the line cannot be read (the file changed or is gone since the analysis)" };
  let hits = identifierHits(text, name);
  if (hits.length === 0) return { why: `the route line does not spell \`${name}\` (the handler is implied by the registration, such as a \`resources\` declaration or a convention)` };
  if (hits.length > 1) {
    // The one written after its class (`clubs#index`), else the one in code when the others are in strings (`'/cup', cup`).
    const after = hits.filter((at) => /[#.:]$/.test(text.slice(Math.max(0, at - 2), at)));
    const code = identifierHits(codeOnly(text, file), name);
    if (after.length === 1) hits = after;
    else if (code.length === 1) hits = code;
    else return { why: `\`${name}\` is written ${hits.length} times on the route line` };
  }
  const at = hits[0]!;
  const inString = identifierHits(codeOnly(text, file), name).length === 0;
  return { span: { file, line, col: at + 1, end: at + 1 + name.length }, inString };
}

const spanText = (s: Span): string => `${s.file}:${s.line}:${s.col}-${s.end}`;

interface Definition {
  file: string;
  symbol: string;
  line: number;
}

/** The definitions the symbol names, from the links that land on it, the hierarchy edges and the function table. */
function definitionsOf(summary: ProjectAnalysis, symbol: string, file: string | undefined): Definition[] {
  const want = symbol.toLowerCase();
  const named = (s: string): boolean => s.toLowerCase() === want || s.toLowerCase().endsWith(`.${want}`);
  const defs = new Map<string, Definition>();
  const add = (f: string, s: string, line: number): void => {
    if (file && f !== file) return;
    if (!defs.has(symbolKey(f, s))) defs.set(symbolKey(f, s), { file: f, symbol: s, line });
  };
  for (const l of summary.symbolLinks ?? []) {
    if (named(l.targetSymbol)) add(l.targetFile, l.targetSymbol, l.targetLine);
    if (l.relation === "implements" && isMemberName(l.sourceSymbol) && named(l.sourceSymbol)) add(l.sourceFile, l.sourceSymbol, l.sourceLine);
  }
  for (const c of summary.complexity ?? []) for (const f of c.functions) if (named(f.functionName)) add(c.filePath, f.functionName, f.line);
  return [...defs.values()].filter((d) => d.symbol !== "(reference)").sort((a, b) => byOrdinal(a.file, b.file) || a.line - b.line);
}

export function renamePlanTool(ctx: ToolContext): McpTool {
  return {
    name: "clarifydoc_rename_plan",
    title: "Rename plan (read-only)",
    description: "Use before renaming a function, method or class: its definition and callers as file:line:col spans, read-only. Refuses on an inferred link, a line naming it twice, or an override.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        to: { type: "string" },
        file: { type: "string" },
        limit: { type: "number" },
      },
      required: ["symbol", "to"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const loaded = await requireAnalysis(ctx);
      const { summary } = loaded;
      const symbol = requiredStringArg(args, "symbol");
      const to = requiredStringArg(args, "to");
      const fileArg = stringArg(args, "file");
      const limit = numberArg(args, "limit", 100, { min: 1, max: 500 });
      if (!IDENTIFIER.test(to)) throw new Error(`\`to\` must be one identifier ([A-Za-z_$][A-Za-z0-9_$]*), got "${to}".`);
      const file = fileArg ? mustResolveFile(loaded, fileArg) : undefined;

      const defs = definitionsOf(summary, symbol, file);
      if (defs.length === 0) {
        const near = nearSymbols(summary, symbol);
        return {
          text: noResults({
            headline: `No function, method or class named \`${symbol}\`${file ? ` in ${file}` : ""} in the analysis.`,
            holds: near?.line ?? `The analysis holds ${plural((summary.symbolLinks ?? []).length, "resolved call")}.`,
            next: [
              !!near && `clarifydoc_rename_plan symbol="${near.first.name}" file="${near.first.file}" to="${to}"`,
              `clarifydoc_search query="${symbol}" kinds=["symbol"] — check the spelling`,
            ],
          }),
        };
      }
      if (defs.length > 1) {
        return {
          text: joinLines([
            `# \`${symbol}\` names ${plural(defs.length, "definition")} — pick one`,
            ...bulletList(defs, DEFINITIONS_LISTED, (d) => `${d.symbol}() ${loc(d.file, d.line)} → clarifydoc_rename_plan symbol="${d.symbol}" file="${d.file}" to="${to}"`),
          ]),
        };
      }
      return { text: await plan(ctx, loaded, defs[0]!, to, limit) };
    },
  };
}

async function plan(ctx: ToolContext, loaded: LoadedAnalysis, def: Definition, to: string, limit: number): Promise<string> {
  const { summary } = loaded;
  const name = leafOf(def.symbol);
  const sources = new Sources(ctx.store.projectRoot);
  const links = summary.symbolLinks ?? [];
  const refusals: Refusal[] = [];
  const refuse = (where: string, why: string): void => void refusals.push({ where, why });
  const heading = `# Rename plan — ${def.symbol}${isClass(summary, def) ? "" : "()"} ${loc(def.file, def.line)} → \`${to}\``;

  if (name === to) throw new Error(`\`${name}\` is already its name.`);

  // The hierarchy: a renamed method that overrides or implements another, or is overridden below, would need all of them.
  const isMember = isMemberName(def.symbol);
  const asTarget = links.filter((l) => l.targetFile === def.file && l.targetSymbol === def.symbol);
  const asSource = links.filter((l) => l.sourceFile === def.file && l.sourceSymbol === def.symbol);
  for (const l of asTarget) if (isMember && l.relation === "implements") refuse(loc(l.sourceFile, l.sourceLine), `${l.sourceSymbol} is the interface or abstract member this implements`);
  for (const l of asSource) if (isMember && l.relation === "implements") refuse(loc(l.targetFile, l.targetLine), `${l.targetSymbol} implements or overrides it`);
  let unchecked = false;
  try {
    const { inheritanceIndex, overridesBelow, declarationsAbove, relatives } = await import("../../core/overrides.js");
    const index = inheritanceIndex(summary.classGraph);
    const classesOf = (f: string) => ctx.store.fileAnalysis(f);
    const [above, below] = isMember
      ? await Promise.all([declarationsAbove(index, links, def.file, def.symbol, classesOf), overridesBelow(index, links, def.file, def.symbol, classesOf)])
      : isClass(summary, def)
        ? [[], await relatives(index, def.file, def.symbol, "down", classesOf)]
        : [[], []];
    for (const r of above) refuse(loc(r.file, r.line || undefined), `${r.symbol} is declared above it (${isMember ? "override or implementation" : "base class"})`);
    for (const r of below) refuse(loc(r.file, r.line || undefined), `${r.symbol} overrides or implements it${isMember ? "" : " (subclass)"}`);
  } catch {
    // The links above still refuse what they state; the hierarchy itself is said to be unchecked.
    unchecked = true;
  }

  // Overloads: one name, several declarations, and the plan would list only one.
  const declared = (summary.complexity ?? []).filter((c) => c.filePath === def.file).flatMap((c) => c.functions).filter((f) => f.functionName === def.symbol);
  if (declared.length > 1) refuse(loc(def.file, def.line), `${declared.length} declarations share this name here (overloads at lines ${declared.map((f) => f.line).join(", ")})`);

  // The new name must not already be a sibling's.
  for (const c of summary.complexity ?? []) {
    if (c.filePath !== def.file) continue;
    const prefix = isMember ? def.symbol.slice(0, def.symbol.length - name.length) : "";
    for (const f of c.functions) if (f.functionName === `${prefix}${to}`) refuse(loc(c.filePath, f.line), `\`${f.functionName}\` already exists beside it`);
  }

  // The definition.
  const sites: Span[] = [];
  const seen = new Set<string>();
  let textual = 0;
  const addSite = async (file: string, line: number, where: string, what: string): Promise<Span | undefined> => {
    const key = `${file}:${line}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const r = await spanOn(sources, file, line, name);
    textual += r.inText;
    if (!r.span) {
      refuse(where, `${what}: ${r.why}`);
      return undefined;
    }
    sites.push(r.span);
    return r.span;
  };
  const defSpan = await addSite(def.file, def.line, loc(def.file, def.line), "definition");

  // The callers: every resolved link reaching it, and each must be certain.
  const callers: SymbolLink[] = asTarget.filter((l) => l.relation !== "implements" && l.relation !== "reference" && l.relation !== "http" && l.relation !== "mq");
  const importers = new Set<string>();
  for (const l of asTarget) if (l.relation === "reference") importers.add(l.sourceFile);
  const callerFiles = new Set<string>();
  const registrations: SymbolLink[] = [];
  for (const l of callers) {
    const where = loc(l.sourceFile, l.sourceLine);
    callerFiles.add(l.sourceFile);
    if (REGISTRATION_STRATEGIES.has(l.strategy ?? "")) {
      // A route declared on the handler itself — its own line, or an annotation/attribute above the method — is the method, already the definition.
      const above = l.sourceFile === def.file ? l.targetLine - l.sourceLine : -1;
      const own = above === 0 || (above > 0 && above <= ANNOTATION_REACH && /^\s*(@|\[|#\[)/.test((await sources.lines(l.sourceFile))?.[l.sourceLine - 1] ?? ""));
      if (!own) registrations.push(l);
      continue;
    }
    if ((l.confidence ?? "INFERRED") !== "EXTRACTED") {
      refuse(where, `the link to it is ${l.confidence ?? "INFERRED"}${l.strategy ? ` (${l.strategy})` : ""}, so this may not be a call of it`);
      continue;
    }
    if (l.overloadsFit) {
      refuse(where, `the call fits ${l.overloadsFit} overloads and the analysis cannot say which it reaches`);
      continue;
    }
    if (l.callName && calledName(l.callName) !== name) {
      refuse(where, `the call is written \`${l.callName}\`, not \`${name}\` (an alias or another name for it)`);
      continue;
    }
    await addSite(l.sourceFile, l.sourceLine, where, "caller");
  }
  const walked = callers.length;

  // The routes that register it: their lines are in their own section, spelled however the framework does.
  const registered: Array<{ span: Span; inString: boolean }> = [];
  const registeredLines = new Set<string>();
  for (const l of registrations) {
    const where = loc(l.sourceFile, l.sourceLine);
    const key = `${l.sourceFile}:${l.sourceLine}`;
    if (registeredLines.has(key)) continue;
    registeredLines.add(key);
    // A route that states its handler (`clubs#index`, `handlers.index`) is certain enough though the linker could only scan for it; a guess is not.
    const states = (l.callName ?? "").split(/[#.:]+/).pop() === name;
    if (l.confidence === "AMBIGUOUS" || (l.confidence !== "EXTRACTED" && !states)) {
      refuse(where, `route registration: the route may not name this definition (${l.strategy}, ${l.confidence ?? "INFERRED"}${l.callName ? `, handler written \`${l.callName}\`` : ""})`);
      continue;
    }
    const r = await registrationSpan(sources, l.sourceFile, l.sourceLine, name);
    if (!r.span) refuse(where, `route registration: ${r.why}`);
    else if (seen.has(key)) continue;
    else registered.push({ span: r.span, inString: !!r.inString });
  }

  // Imports, exports and re-exports that name it.
  const around: string[] = [];
  const files = [...new Set([def.file, ...callerFiles, ...importers])].sort(byOrdinal);
  for (const f of files.slice(0, IMPORT_FILES_READ)) {
    const fa = await ctx.store.fileAnalysis(f);
    if (!fa) continue;
    for (const imp of fa.imports ?? []) {
      const renamedFrom = Object.entries(imp.aliases ?? {}).find(([, exported]) => exported === name);
      if (renamedFrom && renamedFrom[0] !== name) {
        around.push(`${loc(f, imp.line)} imports it as \`${renamedFrom[0]}\` from ${imp.source}; the local name stays, the imported name changes`);
      } else if (imp.specifiers.includes(name) && f !== def.file) {
        around.push(`${loc(f, imp.line)} imports it from ${imp.source}${await colOf(sources, f, imp.line, name)}`);
      }
    }
    for (const ex of fa.exports ?? []) {
      if (ex.name !== name) continue;
      around.push(`${loc(f, ex.line)} ${ex.kind === "re-export" ? "re-exports" : "exports"} it${await colOf(sources, f, ex.line, name)}`);
    }
  }

  const unreadFiles = Math.max(0, files.length - IMPORT_FILES_READ);
  const invisible = (unchecked ? "The hierarchy could not be read, so overrides were NOT checked. " : "") + "Dynamic uses (a name in a string, reflection, a template, a config file, another repository) are invisible to this plan" +
    `${textual > 0 ? `; ${plural(textual, "occurrence")} of \`${name}\` in strings or comments on the lines read` : ""}.`;

  if (refusals.length > 0) {
    return joinLines([
      heading,
      "",
      `**Refused — no plan.** ${plural(refusals.length, "row")} stand${refusals.length === 1 ? "s" : ""} in the way (of ${plural(walked, "link")} reaching it):`,
      ...bulletList(refusals, REFUSED_LISTED, (r) => `${r.where} — ${r.why}`),
      "",
      "Rename these by hand or with a language server; a partial plan would leave a call pointing at a name that is gone.",
      invisible,
    ]);
  }

  sites.sort((a, b) => byOrdinal(a.file, b.file) || a.line - b.line);
  const callSites = sites.filter((s) => s !== defSpan);
  registered.sort((a, b) => byOrdinal(a.span.file, b.span.file) || a.span.line - b.span.line);
  return joinLines([
    heading,
    "",
    `Nothing is written. ${plural(sites.length + registered.length, "span")} in ${plural(new Set([...sites, ...registered.map((r) => r.span)].map((s) => s.file)).size, "file")}: the definition, ${plural(callSites.length, "call site")}${registered.length ? ` and ${plural(registered.length, "route registration")}` : ""}, all EXTRACTED or stated by the route, each with the name once on its line. Spans are \`file:line:start-end\` (1-based columns in characters, end exclusive).`,
    "",
    "## Definition",
    `- ${defSpan ? spanText(defSpan) : loc(def.file, def.line)}`,
    "",
    `## Callers (${callSites.length})`,
    ...(callSites.length === 0 ? ["- no resolved caller; that is a lower bound, not proof of none"] : bulletList(callSites, limit, spanText)),
    "",
    ...(registered.length === 0
      ? []
      : [
          `## Route registrations (${registered.length})`,
          ...bulletList(registered, Math.min(limit, REGISTRATIONS_LISTED), (r) => `${spanText(r.span)}${r.inString ? " (inside a string)" : ""}`),
          "",
        ]),
    `## Imports and exports naming it (${around.length})`,
    ...(around.length === 0 ? ["- none read"] : bulletList(around, limit, (r) => r)),
    ...(unreadFiles ? [`- imports of ${plural(unreadFiles, "more file")} not read`] : []),
    "",
    invisible,
  ]);
}

function isClass(summary: ProjectAnalysis, def: Definition): boolean {
  return (summary.classGraph?.nodes ?? []).some((n) => !n.isFile && !n.isExternal && n.filePath === def.file && n.name === def.symbol);
}

/** ` (line:col-end)` for the name on a line, or nothing where it is not exactly once. */
async function colOf(sources: Sources, file: string, line: number, name: string): Promise<string> {
  const r = await spanOn(sources, file, line, name);
  return r.span ? ` — ${spanText(r.span)}` : " — check the line by hand";
}
