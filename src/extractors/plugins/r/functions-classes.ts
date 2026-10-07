import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, Language } from "../../functions-classes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { assignment, callArgs, callName, leafOf, stringValue } from "./syntax.js";

/** Class generators whose `public` / `private` / `active` / `methods` lists hold methods. */
const CLASS_GENERATORS = new Set(["R6Class", "setRefClass"]);

/**
 * R functions and classes.
 *
 *  - Functions: `name <- function(args) …` (also `=`, `<<-`, `->`) at the
 *    top level of the file.
 *  - Classes: R6 (`Repo <- R6Class("Repo", public = list(find = function(id) …))`,
 *    `inherit = Base`), Reference classes (`setRefClass("Repo", fields = …,
 *    methods = list(…))`) and S4 (`setClass("Repo", representation(con = "ANY"))`
 *    with `setMethod("find", "Repo", function(obj, id) …)` as its methods).
 */
export class RExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["r"];

  protected collectFunctions(root: Node, functions: FunctionInfo[]): void {
    for (const node of root.namedChildren) {
      const bound = assignment(node);
      if (bound?.value.type === "function_definition") functions.push(fn(bound.name, bound.value, node));
    }
  }

  protected collectClasses(root: Node, classes: ClassInfo[]): void {
    const s4 = new Map<string, ClassInfo>();
    for (const node of root.namedChildren) {
      const bound = assignment(node);
      const call = bound?.value.type === "call" ? bound.value : node.type === "call" ? node : null;
      if (!call) continue;
      const name = callName(call);
      const leaf = name ? leafOf(name) : null;
      const args = callArgs(call);
      if (leaf && CLASS_GENERATORS.has(leaf)) {
        const className = stringValue(args[0]?.value) ?? bound?.name ?? "anonymous";
        const cls = classInfo(className, node);
        const base = args.find((a) => a.name === "inherit" || a.name === "contains")?.value;
        if (base) cls.extends = stringValue(base) ?? base.text;
        for (const a of args) {
          if (!a.name || !/^(?:public|private|active|methods)$/.test(a.name) || a.value?.type !== "call") continue;
          for (const member of callArgs(a.value)) {
            if (!member.name || !member.value) continue;
            if (member.value.type === "function_definition") {
              const m = fn(member.name === "initialize" ? className : member.name, member.value, member.node);
              m.isExported = a.name !== "private";
              cls.methods.push(m);
            } else {
              cls.properties.push({ name: member.name, type: null, visibility: a.name === "private" ? "private" : "public", isStatic: false, isReadonly: false });
            }
          }
        }
        // setRefClass(fields = list(con = "ANY")) / c(name = "character")
        const fields = args.find((a) => a.name === "fields")?.value;
        if (fields?.type === "call") {
          for (const f of callArgs(fields)) if (f.name) cls.properties.push({ name: f.name, type: stringValue(f.value), visibility: "public", isStatic: false, isReadonly: false });
        }
        classes.push(cls);
      } else if (leaf === "setClass") {
        const className = stringValue(args[0]?.value);
        if (!className) continue;
        const cls = classInfo(className, node);
        const contains = args.find((a) => a.name === "contains")?.value;
        if (contains) cls.extends = stringValue(contains);
        const slots = args.find((a) => a.name === "representation" || a.name === "slots")?.value ?? args[1]?.value;
        if (slots?.type === "call") {
          for (const f of callArgs(slots)) if (f.name) cls.properties.push({ name: f.name, type: stringValue(f.value), visibility: "public", isStatic: false, isReadonly: false });
        }
        s4.set(className, cls);
        classes.push(cls);
      } else if (leaf === "setMethod") {
        const method = stringValue(args[0]?.value);
        const owner = stringValue(args[1]?.value);
        const def = args.find((a) => a.value?.type === "function_definition")?.value;
        if (!method || !owner || !def) continue;
        let cls = s4.get(owner);
        if (!cls) {
          cls = classInfo(owner, node);
          s4.set(owner, cls);
          classes.push(cls);
        }
        cls.methods.push(fn(method, def, node));
      }
    }
  }
}

function classInfo(name: string, node: Node): ClassInfo {
  return {
    name, extends: null, implements: [], decorators: [], methods: [], properties: [], isExported: true,
    line: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
  };
}

function fn(name: string, def: Node, span: Node): FunctionInfo {
  const params: ParamInfo[] = (def.childForFieldName("parameters")?.namedChildren ?? [])
    .filter((p) => p.type === "parameter")
    .map((p) => ({ name: p.childForFieldName("name")?.text ?? p.text, type: null, defaultValue: p.childForFieldName("default")?.text ?? null }));
  return {
    name,
    params,
    returnType: null,
    isAsync: false,
    isExported: !name.startsWith("."),
    decorators: [],
    calls: extractCalls(def.childForFieldName("body"), "r"),
    line: span.startPosition.row + 1,
    endLine: span.endPosition.row + 1,
  };
}
