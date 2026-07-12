import type { CallInfo, FunctionInfo, RouteInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Spring XML definitions — the declarative wiring tier of classic Java web
 * monoliths. Two formats share the `.xml` extension (the meta's preprocess
 * sniffs the content and skips every other XML file):
 *
 *  1. Spring Web Flow definitions (`<flow xmlns="…/schema/webflow">`): the
 *     application's ROUTING + CONTROLLER wiring. Each `<view-state
 *     view="/account/details">` is a frontend route whose page is a JSP; its
 *     `<transition on="approve" to="…">` edges are the click events the JSP's
 *     taglib buttons fire; `<evaluate expression="bean.method"/>` names the
 *     Java method that runs. States become functions (so they appear in the
 *     trace graph), transitions become `on:<event>` calls carrying the target
 *     state, evaluates become `bean.method` calls — the webflow dispatch
 *     resolver joins all three to the JSP screens and Java action classes.
 *
 *  2. Spring bean definitions (`<bean id="x" class="com.y.Z">`): the bean-id →
 *     class map that makes `<evaluate expression="x.method">` resolvable. Bean
 *     ids surface as `stringConstants` — the same generic named-constant
 *     channel C's table macros use. NOTE: that channel is also unioned by
 *     `resolveDataSourceStringConstants`, which rewrites database dataSource
 *     targets/entities matching a constant NAME; a bean id would have to
 *     exactly equal a dataSource's table token to interfere (bean ids are
 *     `snake_case_action`-shaped, table tokens are macro/entity names, so a
 *     collision is contrived — but it is not impossible by construction).
 */

// ─── Tolerant XML tag scan (tags span lines; quoted '>' must not close) ─────
const XML_TAG_RE = /<(\/?)([a-zA-Z][\w.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

function attrOf(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"|(?:^|\\s)${name}\\s*=\\s*'([^']*)'`));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

interface XmlTag {
  close: boolean;
  name: string;
  attrs: string;
  selfClose: boolean;
  line: number;
}

function scanTags(source: string): XmlTag[] {
  // Blank XML comments first so commented-out states don't parse.
  const masked = source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const out: XmlTag[] = [];
  // Running newline count — matchAll yields ascending indices, so each line
  // number costs only the characters since the previous match.
  let lastIndex = 0;
  let line = 1;
  for (const m of masked.matchAll(XML_TAG_RE)) {
    if (m[2]!.startsWith("!") || m[2]!.startsWith("?")) continue;
    for (let i = lastIndex; i < m.index!; i++) {
      if (masked.charCodeAt(i) === 10) line++;
    }
    lastIndex = m.index!;
    out.push({ close: m[1] === "/", name: m[2]!, attrs: m[3] ?? "", selfClose: m[4] === "/", line });
  }
  return out;
}

// The spec hooks below (functions, routes, constants) each need the parsed
// file, but the regex extractor invokes them independently on the same
// `lines` array — memoize one parse per file instead of scanning thrice.
const PARSE_CACHE = new WeakMap<string[], { tags: XmlTag[]; flow: ParsedFlow | null }>();

function parsedOf(lines: string[]): { tags: XmlTag[]; flow: ParsedFlow | null } {
  let entry = PARSE_CACHE.get(lines);
  if (!entry) {
    const tags = scanTags(lines.join("\n"));
    entry = { tags, flow: parseFlowTags(tags) };
    PARSE_CACHE.set(lines, entry);
  }
  return entry;
}

// ─── Web Flow parsing ────────────────────────────────────────────────────────

const STATE_TAGS = new Set(["view-state", "action-state", "decision-state", "subflow-state", "end-state"]);

/** EL roots that are flow-runtime scopes/context, never Spring beans. */
const SCOPE_ROOTS = new Set([
  "flowScope", "viewScope", "requestScope", "flashScope", "conversationScope",
  "externalContext", "requestParameters", "messageContext", "flowRequestContext",
  "currentEvent", "currentUser", "resourceBundle", "flowExecutionContext", "model",
]);

/** `bean.method` references inside an evaluate/test/set expression. */
function exprCalls(expr: string, line: number): CallInfo[] {
  const out: CallInfo[] = [];
  const seen = new Set<string>();
  for (const m of expr.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g)) {
    const segs = m[1]!.split(".");
    if (SCOPE_ROOTS.has(segs[0]!)) continue;
    // beanId.method — for deeper chains take root + leaf (`bean.prop.method`).
    const name = `${segs[0]}.${segs[segs.length - 1]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, kind: "internal", target: null, line });
  }
  return out;
}

export interface FlowState {
  id: string;
  kind: string;
  view: string | null;
  line: number;
  endLine: number;
  calls: CallInfo[];
}

export interface ParsedFlow {
  /** Flow-level calls: global transitions, on-start/on-end evaluates. */
  flowCalls: CallInfo[];
  states: FlowState[];
  lastLine: number;
}

/** Parse a Web Flow definition into states with transition/evaluate calls. */
export function parseFlow(source: string): ParsedFlow | null {
  return parseFlowTags(scanTags(source));
}

function parseFlowTags(tags: XmlTag[]): ParsedFlow | null {
  if (!tags.some((t) => !t.close && t.name === "flow")) return null;

  const flowCalls: CallInfo[] = [];
  const states: FlowState[] = [];
  let current: FlowState | null = null;
  const calls = () => (current ? current.calls : flowCalls);

  for (const tag of tags) {
    if (STATE_TAGS.has(tag.name)) {
      if (tag.close) {
        if (current) current.endLine = tag.line;
        current = null;
        continue;
      }
      const id = attrOf(tag.attrs, "id") ?? `${tag.name}@${tag.line}`;
      current = {
        id,
        kind: tag.name,
        view: attrOf(tag.attrs, "view"),
        line: tag.line,
        endLine: tag.line,
        calls: [],
      };
      states.push(current);
      if (tag.name === "subflow-state") {
        const sub = attrOf(tag.attrs, "subflow");
        if (sub) current.calls.push({ name: `subflow:${sub}`, kind: "internal", target: sub, line: tag.line });
      }
      if (tag.selfClose) current = null;
      continue;
    }
    if (tag.close) continue;

    switch (tag.name) {
      case "transition": {
        const on = attrOf(tag.attrs, "on");
        const to = attrOf(tag.attrs, "to");
        if (on || to) calls().push({ name: `on:${on ?? "*"}`, kind: "internal", target: to, line: tag.line });
        break;
      }
      case "evaluate": {
        const expr = attrOf(tag.attrs, "expression");
        if (expr) calls().push(...exprCalls(expr, tag.line));
        break;
      }
      case "if": {
        const test = attrOf(tag.attrs, "test");
        if (test) calls().push(...exprCalls(test, tag.line));
        // Decision edges chase like transitions (no event name).
        for (const branch of ["then", "else"] as const) {
          const to = attrOf(tag.attrs, branch);
          if (to) calls().push({ name: `on:${branch}`, kind: "internal", target: to, line: tag.line });
        }
        break;
      }
      case "set": {
        const value = attrOf(tag.attrs, "value");
        if (value) calls().push(...exprCalls(value, tag.line));
        break;
      }
    }
  }

  return { flowCalls, states, lastLine: tags.length > 0 ? tags[tags.length - 1]!.line : 1 };
}

/** Flow id = file basename minus extension (`league.wf.club.manage.xml` → `league.wf.club.manage`). */
export function flowIdOf(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop()!.replace(/\.xml$/i, "");
}

// ─── Spec hooks ──────────────────────────────────────────────────────────────

function fn(name: string, line: number, endLine: number, calls: CallInfo[], kind: string): FunctionInfo {
  return {
    name, params: [], returnType: null, isAsync: false, isExported: false,
    // The state kind rides along as a decorator (`view-state`, `action-state`,
    // …) so the dispatch resolver can tell screens from behaviour without
    // re-parsing the XML.
    decorators: [kind], calls, line, endLine,
  };
}

/** States → functions, so flow steps join the symbol/trace graph. */
function extractFlowFunctions(lines: string[]): FunctionInfo[] {
  const { flow } = parsedOf(lines);
  if (!flow) return [];
  const out: FunctionInfo[] = [fn("<flow>", 1, flow.lastLine, flow.flowCalls, "flow")];
  for (const s of flow.states) out.push(fn(s.id, s.line, s.endLine, s.calls, s.kind));
  return out;
}

/** View-states → frontend routes; `componentPath` carries the JSP view path. */
function extractFlowRoutes(lines: string[], filePath?: string): RouteInfo[] {
  if (!filePath) return [];
  const { flow } = parsedOf(lines);
  if (!flow) return [];
  const flowId = flowIdOf(filePath);
  const routes: RouteInfo[] = [];
  for (const s of flow.states) {
    if (s.kind !== "view-state" || !s.view) continue;
    // Handler = the view's basename: meaningful in the Routes tab, and inert
    // for the generic linker (JSPs expose no symbols to false-match).
    const viewBase = s.view.replace(/\\/g, "/").split("/").pop()!.replace(/\.\w+$/, "");
    routes.push({
      path: routes.length === 0 ? flowId : `${flowId}#${s.id}`,
      httpMethod: null,
      kind: "frontend",
      handler: viewBase,
      componentPath: s.view,
      calls: [],
      middleware: [],
      line: s.line,
    });
  }
  return routes;
}

/** `<bean id="x" class="com.y.Z">` → named constants (the bean-id → class map). */
function extractBeanConstants(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of parsedOf(lines).tags) {
    if (tag.close || tag.name !== "bean") continue;
    const id = attrOf(tag.attrs, "id") ?? attrOf(tag.attrs, "name");
    const cls = attrOf(tag.attrs, "class");
    if (id && cls) out[id] = cls;
  }
  return out;
}

export const springxmlSpec: RegexLangSpec = {
  language: "springxml",
  extensions: [".xml"],
  blockStyle: "brace",
  lineCommentPrefixes: ["<!--"],

  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],

  postProcessFunctions: (lines) => extractFlowFunctions(lines),
  extractRoutes: (lines, _classes, filePath) => extractFlowRoutes(lines, filePath),
  extractStringConstants: extractBeanConstants,
};
