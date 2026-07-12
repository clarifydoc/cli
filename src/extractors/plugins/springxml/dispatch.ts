import type { ClassInfo, FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { pickByPathAffinity, resolveViewBySuffix } from "../shared/path-utils.js";
import { flowIdOf } from "./index.js";

/**
 * Spring Web Flow UI bridge. A classic Java web monolith wires its UI in three
 * declarative hops the generic symbol linker cannot see:
 *
 *   JSP `<club:button event="approve">`                 (jsp plugin: element, handler="approve")
 *     → flow `<view-state view="/account/details">`    (springxml plugin: route + state fn)
 *         `<transition on="approve" to="doApprove">`   (state call `on:approve` → target state)
 *           `<evaluate expression="bean.method"/>`     (state call `bean.method`)
 *             → `<bean id="bean" class="com.x.Action">` (springxml stringConstants)
 *               → the Java class's method              (java plugin)
 *
 * This resolver replays those hops and emits synthetic links:
 *  a. flow state  → Java method, for every `bean.method` evaluate call;
 *  b. flow route  → its JSP view (`route:USE <path>` → `<component>`), giving
 *     frontend routes a trace anchor;
 *  c. JSP element → Java method: the element's event chased through the
 *     view-state's transitions into action-state evaluate chains
 *     (callName = the event, which is what the element's handler holds);
 *  d. subflow-state → the target flow file's `<flow>` root.
 */
export class WebflowUiBridgeResolver implements DispatchResolver {
  readonly languages: Language[] = ["springxml", "jsp", "java"];

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const flows = analyses.filter((a) => a.language === "springxml" && a.functions.some((f) => f.name === "<flow>"));
    if (flows.length === 0) return [];

    // Bean id → class FQN, unioned across every Spring XML file.
    const beanClass = new Map<string, string>();
    for (const a of analyses) {
      if (a.language !== "springxml") continue;
      for (const [id, cls] of Object.entries(a.stringConstants ?? {})) beanClass.set(id, cls);
    }

    // Java class name → declaring files.
    const javaByClass = new Map<string, { file: string; cls: ClassInfo }[]>();
    for (const a of analyses) {
      if (a.language !== "java") continue;
      for (const cls of a.classes ?? []) {
        const list = javaByClass.get(cls.name) ?? [];
        list.push({ file: a.filePath, cls });
        javaByClass.set(cls.name, list);
      }
    }

    const jsps = analyses.filter((a) => a.language === "jsp");
    const flowById = new Map(flows.map((a) => [flowIdOf(a.filePath), a]));

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const add = (l: SymbolLink) => {
      const k = `${l.sourceFile}|${l.sourceSymbol}|${l.sourceLine}|${l.targetFile}|${l.targetSymbol}|${l.callName}`;
      if (!seen.has(k)) {
        seen.add(k);
        links.push(l);
      }
    };

    /** `beanId.method` → Java target (method if declared, class anchor for
     *  inherited framework methods like FormAction.bindAndValidate). */
    const resolveBeanCall = (name: string, fromFile: string) => {
      const m = name.match(/^([\w$]+)\.([\w$]+)$/);
      if (!m) return null;
      const fqn = beanClass.get(m[1]!);
      if (!fqn) return null;
      const clsName = fqn.split(".").pop()!;
      const candidates = javaByClass.get(clsName) ?? [];
      if (candidates.length === 0) return null;
      // Prefer the file whose path IS the FQN (com.x.Y → **/com/x/Y.java).
      const fqnPath = fqn.replace(/\./g, "/") + ".java";
      let best = candidates.find((c) => c.file.replace(/\\/g, "/").endsWith(fqnPath)) ?? null;
      if (!best) best = pickByPathAffinity(candidates, (c) => c.file, fromFile);
      if (!best) return null;
      // Inherited framework methods (FormAction.bindAndValidate) aren't on the
      // project class — fall back to the class anchor below.
      const method = best.cls.methods.find((mm) => mm.name === m[2]!);
      return method
        ? { file: best.file, symbol: `${best.cls.name}.${method.name}`, line: method.line }
        : { file: best.file, symbol: best.cls.name, line: best.cls.line };
    };

    for (const flow of flows) {
      const states = new Map(flow.functions.map((f) => [f.name, f]));
      const globalTransitions = (states.get("<flow>")?.calls ?? []).filter((c) => c.name.startsWith("on:"));

      // (a) every evaluate call resolves to its Java bean method.
      for (const fnDef of flow.functions) {
        for (const call of fnDef.calls) {
          if (call.name.startsWith("on:") || call.name.startsWith("subflow:")) continue;
          const hit = resolveBeanCall(call.name, flow.filePath);
          if (!hit) continue;
          add({
            sourceFile: flow.filePath,
            sourceSymbol: fnDef.name,
            sourceLine: call.line,
            callName: call.name,
            targetFile: hit.file,
            targetSymbol: hit.symbol,
            targetLine: hit.line,
            confidence: "INFERRED",
          });
        }

        // (d) subflow edges → the target flow's root.
        for (const call of fnDef.calls) {
          if (!call.name.startsWith("subflow:")) continue;
          const target = flowById.get(call.name.slice("subflow:".length));
          if (!target) continue;
          add({
            sourceFile: flow.filePath,
            sourceSymbol: fnDef.name,
            sourceLine: call.line,
            callName: call.name,
            targetFile: target.filePath,
            targetSymbol: "<flow>",
            targetLine: 1,
            confidence: "INFERRED",
          });
        }
      }

      // (b) + (c): per view-state route — anchor to the JSP, then wire the
      // JSP's event-carrying elements through this state's transitions.
      for (const route of flow.routes) {
        const jsp = resolveView(route.componentPath, jsps, flow.filePath);
        if (!jsp) continue;

        add({
          sourceFile: flow.filePath,
          sourceSymbol: `route:USE ${route.path}`,
          sourceLine: route.line,
          callName: route.handler ?? route.path,
          targetFile: jsp.filePath,
          targetSymbol: "<component>",
          targetLine: 1,
          confidence: "INFERRED",
        });

        // handler (state id) is stored on the route only as the view basename;
        // recover the state fn by line instead (route.line == state open line).
        const stateFn = flow.functions.find((f) => f.line === route.line && f.name !== "<flow>");
        if (!stateFn) continue;

        for (const el of jsp.interactiveElements ?? []) {
          if (!el.handler) continue;
          const chain = chaseEvent(el.handler, stateFn, states, globalTransitions);
          for (const evalName of chain) {
            const hit = resolveBeanCall(evalName, flow.filePath);
            if (!hit) continue;
            add({
              sourceFile: jsp.filePath,
              sourceSymbol: "<component>",
              sourceLine: el.line,
              callName: el.handler,
              targetFile: hit.file,
              targetSymbol: hit.symbol,
              targetLine: hit.line,
              confidence: "INFERRED",
            });
          }
        }
      }
    }
    return links;
  }
}

/** Web Flow view → JSP file, by path suffix (see resolveViewBySuffix). */
function resolveView(
  view: string | null | undefined,
  jsps: FileAnalysis[],
  flowFile: string,
): FileAnalysis | null {
  if (!view) return null;
  const hit = resolveViewBySuffix(view, jsps.map((j) => j.filePath), flowFile);
  return hit ? (jsps.find((j) => j.filePath === hit) ?? null) : null;
}

/**
 * Chase an element's event through the state machine: the matching
 * `<transition on=event>` (view-state first, global fallback) leads to
 * action/decision states whose evaluate calls ARE the click's handlers.
 * Landing on another view/end state collects its on-entry evaluates (they run
 * as part of the click) but stops there — that's the next screen, not more
 * behaviour of this click.
 */
function chaseEvent(
  event: string,
  stateFn: FunctionInfo,
  states: Map<string, FunctionInfo>,
  globalTransitions: { name: string; target: string | null }[],
): string[] {
  const own = stateFn.calls.filter((c) => c.name === `on:${event}`);
  const transitions = own.length > 0 ? own : globalTransitions.filter((c) => c.name === `on:${event}`);

  const out: string[] = [];
  const visited = new Set<string>([stateFn.name]);
  let frontier = transitions.map((t) => t.target).filter((t): t is string => !!t);
  let depth = 0;
  while (frontier.length > 0 && depth < 6) {
    const next: string[] = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      const st = states.get(id);
      if (!st) continue;
      for (const c of st.calls) {
        if (!c.name.startsWith("on:") && !c.name.startsWith("subflow:")) out.push(c.name);
      }
      const kind = st.decorators[0] ?? "";
      if (kind === "view-state" || kind === "end-state") continue;
      for (const t of st.calls) {
        if (t.name.startsWith("on:") && t.target) next.push(t.target);
      }
    }
    frontier = next;
    depth++;
  }
  return [...new Set(out)];
}
