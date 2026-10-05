import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import type { CallInfo, RouteParamInfo } from "../../../types/analysis.js";
import { getVisibility, extractJsDecorators, stripQuotes } from "../../shared/node-helpers.js";
import { REQUEST_PARAM_NAMES, scanRequestAccess } from "./request-access.js";
import { extractCalls } from "../../shared/call-graph.js";
import { foldValue, type ValueExpr } from "../../shared/value-resolver.js";
import { astToValueExpr } from "./value-capture.js";

/**
 * Dynamic `import("./x.vue")` calls inside a function body, surfaced as
 * cross-file call edges so lazy-loaded modules — route targets and components
 * launched via `useDialog().open({ component: import("./dlg.vue") })` — stay
 * reachable in the call/trace graph instead of dead-ending at the loader.
 *
 * Launchers usually wrap the import in a callback (`new Promise((res) => …)`),
 * which `extractCalls` skips as a nested scope, so this descends through
 * anonymous arrows/function-expressions but stops at nested *named* functions
 * and classes (those are linked as their own units). The target resolves to the
 * imported module's default export — for a `.vue` that's the component itself.
 */
function collectDynamicImportCalls(body: Node | null): CallInfo[] {
  if (!body) return [];
  const out: CallInfo[] = [];
  const seen = new Set<string>();

  const walk = (node: Node, isRoot: boolean): void => {
    if (
      !isRoot &&
      (node.type === "function_declaration" ||
        node.type === "generator_function_declaration" ||
        node.type === "class_declaration" ||
        node.type === "class")
    ) {
      return;
    }

    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      if (callee && callee.type === "import") {
        const arg = node.childForFieldName("arguments")?.child(1);
        if (arg && arg.type === "string") {
          const source = stripQuotes(arg.text);
          // Project-local specifiers only (relative or path-alias) — a bare
          // package import isn't a project file. Unresolvable ones simply
          // produce no link downstream.
          const local = /^[./]/.test(source) || /^[@~]/.test(source);
          if (local && !seen.has(source)) {
            seen.add(source);
            out.push({
              name: "default",
              kind: "cross-file",
              target: source,
              line: node.startPosition.row + 1,
              confidence: "EXTRACTED",
            });
          }
        }
      }
    }

    for (const child of node.children) walk(child, false);
  };

  walk(body, true);
  return out;
}

/**
 * If a function's return value is an app-relative request URL built from string
 * concatenation / a template literal, derive its parameterized template(s):
 * path literals verbatim, each parameter referenced in the URL as `{paramName}`,
 * a base that is not part of the path — an environment read (`import.meta.env
 * .VITE_X` / `process.env.Y`), a runtime config read (`store.state.config
 * .API_URL`) or a literal origin (`http://localhost`) — dropped, and any other
 * runtime reference (a closure/local variable) as `{}`. Empty for non-URL
 * functions (a result must contain a `/`).
 *
 * Real Vue/React data layers funnel every request through such a helper
 * (`requestUri(endpoint, version)`, `adminUri(subPath)`), so without resolving
 * it the api-call carries no joinable URL. A project-level pass substitutes a
 * call site's literal args into these templates.
 *
 * One template per DISTINCT branch, in source order: the helper's `return`
 * statements, including those nested in `if`/`else` (a mock-vs-real switch on
 * an env flag), and both arms of a returned ternary (`isEmployee ? base +
 * "/api/staff/" + p : base + "/api/" + p`). Branches that only differ in
 * a dropped base collapse to one template, so the common mock switch yields a
 * single template while a genuine role switch yields two. A one-hop local
 * (`const x = <url>; return x`) is followed; deeper flow is not.
 */
export function extractUrlTemplates(
  body: Node | null,
  paramNames: ReadonlySet<string>,
): string[] {
  if (!body) return [];

  // Top-level `const/let x = <expr>` bindings, for a `return x` indirection.
  const locals = new Map<string, Node>();
  const returns: Node[] = [];
  if (body.type === "statement_block") {
    collectReturns(body.namedChildren, locals, returns, 0);
  } else {
    // Expression-bodied arrow: the body itself is the returned expression.
    returns.push(body);
  }
  if (returns.length === 0) return [];

  // Capture the pre-return top-level consts as a function-local scope, then fold
  // each returned branch. `envMode: "collapse"` drops an environment base to
  // "" (the template is app-relative).
  const scope = new Map<string, ValueExpr>();
  for (const [name, valueNode] of locals) {
    scope.set(name, astToValueExpr(valueNode));
  }
  const templates: string[] = [];
  for (const ret of returns) {
    for (const branch of ternaryArms(ret, 0)) {
      const { text } = foldValue(astToValueExpr(branch), scope, {
        params: paramNames,
        envMode: "collapse",
      });
      if (text == null) continue;
      const tpl = stripUrlBase(text);
      if (!tpl.includes("/") || templates.includes(tpl)) continue;
      templates.push(tpl);
      if (templates.length >= MAX_URL_TEMPLATES) return templates;
    }
  }
  return templates;
}

/** The first (primary) URL template of a function body; see {@link extractUrlTemplates}. */
export function extractUrlTemplate(
  body: Node | null,
  paramNames: ReadonlySet<string>,
): string | undefined {
  return extractUrlTemplates(body, paramNames)[0];
}

const MAX_URL_TEMPLATES = 6;
const MAX_RETURN_DEPTH = 4;

/**
 * Every `return <expr>` reachable in a statement list through `if`/`else`
 * nesting, in source order, plus the variable bindings seen on the way. Loops,
 * `try` and `switch` are not entered: a URL assembled inside one is not a
 * branch of the helper but a computation this pass does not model.
 */
function collectReturns(stmts: readonly Node[], locals: Map<string, Node>, out: Node[], depth: number): void {
  if (depth > MAX_RETURN_DEPTH) return;
  for (const stmt of stmts) {
    if (stmt.type === "lexical_declaration" || stmt.type === "variable_declaration") {
      for (const decl of stmt.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const nm = decl.childForFieldName("name");
        const val = decl.childForFieldName("value");
        if (nm?.type === "identifier" && val && !locals.has(nm.text)) locals.set(nm.text, val);
      }
    } else if (stmt.type === "return_statement") {
      const expr = stmt.namedChild(0);
      if (expr) out.push(expr);
    } else if (stmt.type === "if_statement") {
      const cons = stmt.childForFieldName("consequence");
      if (cons) collectReturns(branchStatements(cons), locals, out, depth + 1);
      const alt = stmt.childForFieldName("alternative")?.namedChild(0); // else_clause → body
      if (alt) collectReturns(branchStatements(alt), locals, out, depth + 1);
    }
  }
}

/** A branch body's statements: a `{…}` block's children, or the one bare statement (`else if`, `else return x`). */
function branchStatements(node: Node): readonly Node[] {
  return node.type === "statement_block" ? node.namedChildren : [node];
}

/** The arms of a (possibly nested / parenthesized) ternary, or the expression itself. */
function ternaryArms(expr: Node, depth: number): Node[] {
  if (depth > MAX_RETURN_DEPTH) return [expr];
  if (expr.type === "parenthesized_expression") {
    const inner = expr.namedChild(0);
    return inner ? ternaryArms(inner, depth + 1) : [expr];
  }
  if (expr.type === "ternary_expression") {
    const cons = expr.childForFieldName("consequence");
    const alt = expr.childForFieldName("alternative");
    return [...(cons ? ternaryArms(cons, depth + 1) : []), ...(alt ? ternaryArms(alt, depth + 1) : [])];
  }
  return [expr];
}

/**
 * Make a folded URL app-relative: drop a literal origin (`http://localhost`)
 * and a leading runtime hole standing in for a configured base
 * (`store.state.config.API_URL + "/api/" + p` folds to `{}/api/{p}`). A base
 * concatenated in front of a `/`-led path is a base by construction; keeping
 * it as a `{}` segment would put a wildcard where the route join expects `/api`.
 */
function stripUrlBase(text: string): string {
  return text.replace(/^https?:\/\/[^/]+/i, "").replace(/^\{\}(?=\/)/, "");
}

/** `urlTemplate` (primary) + `urlTemplateAlternatives` (the other branches), or nothing. */
function urlTemplateFields(templates: string[]): Pick<FunctionInfo, "urlTemplate" | "urlTemplateAlternatives"> {
  if (templates.length === 0) return {};
  return {
    urlTemplate: templates[0],
    ...(templates.length > 1 ? { urlTemplateAlternatives: templates.slice(1) } : {}),
  };
}

/**
 * Bare name of a type reference: drops type arguments and trailing whitespace
 * so `Repo<User>` matches the declaration named `Repo`. Keeps dotted names
 * (`React.Component`) intact — that is how the source names the base.
 */
function bareTypeName(text: string): string {
  const cut = text.indexOf("<");
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * Decorators that are CHILDREN of a node (class fields, parameters — unlike
 * methods, whose decorators are class-body siblings): full text with
 * arguments, `@` dropped, whitespace collapsed (`IsString()`, `Expose({ name: 'x' })`).
 */
function childDecorators(node: Node): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    if (child.type === "decorator") out.push(child.text.replace(/^@/, "").replace(/\s+/g, " ").trim());
  }
  return out;
}

/** A `?` token among a node's children — TS optional field, parameter or property signature. */
function hasOptionalMarker(node: Node): boolean {
  return node.children.some((c) => c.type === "?");
}

/**
 * What a handler-shaped function reads off its request object: only when the
 * first parameter is named like one (`req`, `request`, `ctx`) — that is how
 * Express/Koa/Fastify handlers declared away from the route line (`router.get
 * ('/', getUsers)`) get their bindings, through the project-level join.
 * Absent (not empty) when the function reads nothing.
 */
function requestAccessOf(params: readonly ParamInfo[], body: Node | null): RouteParamInfo[] | undefined {
  const first = params[0]?.name;
  if (!first || !body || !REQUEST_PARAM_NAMES.has(first)) return undefined;
  const access = scanRequestAccess(body.text, first);
  return access.length > 0 ? access : undefined;
}

/** How deep a namespace object nests before its members stop being named (`api.users.admin.get`). */
const MAX_NAMESPACE_DEPTH = 3;

/**
 * Keys only a Vue component's options object carries. Its `methods` are
 * flattened onto `this` (called as `this.save()`, bound as `@click="save"`), so
 * naming them `methods.save` would invent symbols nothing calls — Options API
 * components are their own extraction problem and are left alone here.
 */
const VUE_OPTION_KEYS = new Set([
  "data", "methods", "computed", "watch", "props", "components", "template",
  "render", "setup", "mixins", "emits", "created", "mounted", "beforeMount",
]);

function isVueComponentOptions(obj: Node): boolean {
  return obj.namedChildren.some((m) => {
    const key = m.type === "pair" ? m.childForFieldName("key") : m.type === "method_definition" ? m.childForFieldName("name") : null;
    const name = objectKeyName(key);
    return name !== null && VUE_OPTION_KEYS.has(name);
  });
}

/** An object key usable as a symbol name: an identifier, or a string that reads as one. Computed keys name nothing. */
function objectKeyName(key: Node | null): string | null {
  if (!key) return null;
  if (key.type === "property_identifier" || key.type === "identifier") return key.text;
  if (key.type === "string") {
    const text = key.text.slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(text) ? text : null;
  }
  return null;
}

export class JavaScriptExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.extractJsFunctions(node, functions, false);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractJsClasses(node, classes);
  }

  private extractJsFunctions(
    node: Node,
    functions: FunctionInfo[],
    isExported: boolean,
  ): void {
    // Declarations directly in the module (or in a top-level `export`) — the
    // only place an object literal of functions is a namespace rather than a
    // value some function builds and passes around.
    const moduleLevel =
      node.type === "program" || (node.type === "export_statement" && node.parent?.type === "program");

    for (const child of node.children) {

      if (child.type === "export_statement") {
        // `export default { Articles, setToken: (t) => … }`: the importer calls
        // `agent.setToken(…)`, so each inline member is named by its key alone.
        const value = child.childForFieldName("value");
        if (moduleLevel && value?.type === "object" && !isVueComponentOptions(value)) {
          this.extractObjectMembers(null, value, functions, true, 0);
        }
        this.extractJsFunctions(child, functions, true);
        continue;
      }

      // CommonJS `module.exports = { … }` — the same namespace object.
      if (moduleLevel && child.type === "expression_statement") {
        const assign = child.namedChild(0);
        const right = assign?.type === "assignment_expression" ? assign.childForFieldName("right") : null;
        if (right?.type === "object" && assign!.childForFieldName("left")?.text === "module.exports" && !isVueComponentOptions(right)) {
          this.extractObjectMembers(null, right, functions, true, 0);
        }
      }

      if (
        child.type === "function_declaration" ||
        child.type === "generator_function_declaration"
      ) {
        functions.push(this.parseJsFunction(child, isExported));
        // Descend into the body: NAMED functions nested inside a function are
        // real symbols — a React component's `const onSubmitHandler = async
        // (e) => {…}` is where the click handling (and its api-calls) actually
        // lives. Skipping them dropped the handler AND its body's calls from
        // the graph, so every React click-trace dead-ended at the component.
        const body = child.childForFieldName("body");
        if (body) this.extractJsFunctions(body, functions, false);
      } else if (
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        for (const decl of child.children) {
          if (decl.type === "variable_declarator") {
            const name = decl.childForFieldName("name")?.text;
            const value = decl.childForFieldName("value");
            if (
              name &&
              value &&
              (value.type === "arrow_function" ||
                value.type === "function_expression")
            ) {
              functions.push(this.parseJsArrowOrExpr(name, value, isExported));
            } else if (name && value?.type === "object" && moduleLevel && decl.childForFieldName("name")?.type === "identifier") {
              // `const Profile = { get: (u) => requests.get(…) }` — an API client
              // or service written as a namespace object. Its members are what
              // callers invoke (`agent.Profile.get`), and the api-calls inside
              // them need an enclosing symbol to belong to.
              this.extractObjectMembers(name, value, functions, isExported, 0);
            }
            // Named bindings can hide anywhere below (an arrow's body, a
            // useEffect callback, a call argument) — keep walking the value.
            if (value) this.extractJsFunctions(value, functions, false);
          }
        }
      } else if (
        child.type === "class_declaration" ||
        child.type === "abstract_class_declaration" ||
        child.type === "class_body"
      ) {
        // Class members are the class extractor's territory.
        continue;
      } else {
        // Generic descent: statements, blocks, JSX, call arguments — anonymous
        // functions are never extracted, but named bindings inside them are.
        this.extractJsFunctions(child, functions, false);
      }
    }
  }

  private parseJsFunction(node: Node, isExported: boolean): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const params = this.extractJsParams(node.childForFieldName("parameters"));
    const returnType = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
    const isAsync = node.text.startsWith("async ");
    const decorators = this.extractDecorators(node);

    const body = node.childForFieldName("body");
    const templates = extractUrlTemplates(body, new Set(params.map((p) => p.name)));
    const requestAccess = requestAccessOf(params, body);
    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      calls: [...extractCalls(body, "typescript"), ...collectDynamicImportCalls(body)],
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...urlTemplateFields(templates),
      ...(requestAccess ? { requestAccess } : {}),
    };
  }

  private parseJsArrowOrExpr(
    name: string,
    node: Node,
    isExported: boolean,
  ): FunctionInfo {
    // Handle type assertions wrapping the arrow function: `const f = ((): T => {}) as const`
    let funcNode = node;
    if (
      funcNode.type === "as_expression" ||
      funcNode.type === "satisfies_expression" ||
      funcNode.type === "type_assertion"
    ) {
      const inner = funcNode.child(0);
      if (inner && (inner.type === "arrow_function" || inner.type === "function_expression")) {
        funcNode = inner;
      }
    }

    // `(u) => …` puts its list in `parameters`; a bare `u => …` puts the one
    // identifier in `parameter`, which used to leave the arrow with no params.
    const params = this.extractJsParams(
      funcNode.childForFieldName("parameters") ?? funcNode.childForFieldName("parameter"),
    );
    const returnType = funcNode.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
    const isAsync = funcNode.text.startsWith("async ");

    // Extract decorators from the parent declaration if present
    const declarator = funcNode.parent;
    const declaration = declarator?.parent;
    const decorators =
      declaration ? this.extractDecorators(declaration) : [];

    const body = funcNode.childForFieldName("body") ?? funcNode;
    const templates = extractUrlTemplates(body, new Set(params.map((p) => p.name)));
    const requestAccess = requestAccessOf(params, body);
    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      calls: [...extractCalls(body, "typescript"), ...collectDynamicImportCalls(body)],
      line: funcNode.startPosition.row + 1,
      endLine: funcNode.endPosition.row + 1,
      ...urlTemplateFields(templates),
      ...(requestAccess ? { requestAccess } : {}),
    };
  }

  /**
   * The function members of a namespace object literal, named
   * `prefix.key` (`Profile.get`) — the same shape the symbol index uses for a
   * class method, so a call `agent.Profile.get` reaches it through the linker's
   * suffix match. A nested object extends the prefix (`api.users.get`). With no
   * prefix (a default-exported object) the key alone is the name. Shorthand
   * entries and spreads reference something defined elsewhere and add nothing.
   */
  private extractObjectMembers(
    prefix: string | null,
    obj: Node,
    functions: FunctionInfo[],
    isExported: boolean,
    depth: number,
  ): void {
    for (const member of obj.namedChildren) {
      if (member.type === "pair") {
        const key = objectKeyName(member.childForFieldName("key"));
        const value = member.childForFieldName("value");
        if (!key || !value) continue;
        const name = prefix ? `${prefix}.${key}` : key;
        if (value.type === "arrow_function" || value.type === "function_expression") {
          functions.push(this.parseJsArrowOrExpr(name, value, isExported));
        } else if (value.type === "object" && depth < MAX_NAMESPACE_DEPTH) {
          this.extractObjectMembers(name, value, functions, isExported, depth + 1);
        }
      } else if (member.type === "method_definition") {
        const key = objectKeyName(member.childForFieldName("name"));
        if (!key) continue;
        const fn = this.parseJsFunction(member, isExported);
        fn.name = prefix ? `${prefix}.${key}` : key;
        functions.push(fn);
      }
    }
  }

  private extractJsParams(paramsNode: Node | null): ParamInfo[] {
    if (!paramsNode) return [];
    if (paramsNode.type === "identifier") {
      return [{ name: paramsNode.text, type: null, defaultValue: null }];
    }
    const params: ParamInfo[] = [];

    for (const child of paramsNode.children) {
      if (
        child.type === "required_parameter" ||
        child.type === "optional_parameter" ||
        child.type === "identifier" ||
        child.type === "rest_pattern"
      ) {
        const name =
          child.childForFieldName("pattern")?.text ??
          child.childForFieldName("name")?.text ??
          child.text;
        const typeNode = child.childForFieldName("type");
        const defaultNode = child.childForFieldName("value");

        params.push({
          name,
          type: typeNode?.text?.replace(/^:\s*/, "") ?? null,
          defaultValue: defaultNode?.text ?? null,
        });
      }
    }
    return params;
  }

  private extractJsClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {
      if (child.type === "export_statement") {
        for (const inner of child.children) {
          this.collectJsClassLike(inner, classes, true);
        }
        continue;
      }
      this.collectJsClassLike(child, classes, false);
    }
  }

  /**
   * A class, an abstract class or a TypeScript interface. Abstract classes and
   * interfaces are first-class here because the symbol linker's interface
   * fan-out (`buildInterfaceImplMap`) resolves a call on an interface-typed
   * receiver to every implementation — machinery that stays dead for TS/JS
   * unless interfaces reach `analysis.classes` with `kind: "interface"`.
   */
  private collectJsClassLike(node: Node, classes: ClassInfo[], isExported: boolean): void {
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
      classes.push(this.parseJsClass(node, isExported));
    } else if (node.type === "interface_declaration") {
      classes.push(this.parseTsInterface(node, isExported));
    }
  }

  /**
   * A TypeScript interface as a ClassInfo: method signatures become methods
   * with no body (so `calls` is empty), property signatures become properties.
   */
  private parseTsInterface(node: Node, isExported: boolean): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const extendsList: string[] = [];
    // `interface A extends B, C` is an `extends_type_clause` CHILD holding one
    // `type` field entry per base — unlike a class, which can only have one.
    for (const child of node.children) {
      if (child.type !== "extends_type_clause") continue;
      for (const t of child.namedChildren) {
        const bare = bareTypeName(t.text);
        if (bare) extendsList.push(bare);
      }
    }

    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    const body = node.childForFieldName("body");
    if (body) {
      for (const member of body.namedChildren) {
        if (member.type === "method_signature") {
          methods.push({
            name: member.childForFieldName("name")?.text ?? "anonymous",
            params: this.extractJsParams(member.childForFieldName("parameters")),
            returnType: member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null,
            isAsync: false,
            isExported: false,
            decorators: [],
            calls: [],
            line: member.startPosition.row + 1,
            endLine: member.endPosition.row + 1,
          });
        } else if (member.type === "property_signature") {
          properties.push({
            name: member.childForFieldName("name")?.text ?? "unknown",
            type: member.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null,
            visibility: null,
            isStatic: false,
            isReadonly: member.text.includes("readonly "),
            isRequired: !hasOptionalMarker(member),
          });
        }
      }
    }

    return {
      name,
      // An interface has no runtime base; the first `extends` keeps the shape
      // other consumers expect, and the rest ride along in `implements` so the
      // impl map can match on either (it inspects both).
      extends: extendsList[0] ?? null,
      implements: extendsList.slice(1),
      decorators: [],
      methods,
      properties,
      isExported,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind: "interface",
    };
  }

  private parseJsClass(node: Node, isExported: boolean): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    let extendsName: string | null = null;
    const implementsList: string[] = [];

    // Heritage is a `class_heritage` CHILD, not a field — reading it as a field
    // (`childForFieldName("heritage")`) silently returned null for every class
    // in every TS and JS file, so inheritance was never recorded for the most
    // common language in the corpus. TS spells the inside as
    // `extends_clause` / `implements_clause`; plain JS has a bare expression.
    for (const child of node.children) {
      if (child.type !== "class_heritage") continue;
      for (const clause of child.namedChildren) {
        if (clause.type === "extends_clause") {
          // `value` excludes `type_arguments`, so `extends Base<T>` -> `Base`.
          extendsName = bareTypeName(clause.childForFieldName("value")?.text ?? "") || null;
        } else if (clause.type === "implements_clause") {
          for (const impl of clause.namedChildren) {
            const bare = bareTypeName(impl.text);
            if (bare) implementsList.push(bare);
          }
        } else {
          // JavaScript: `class_heritage` holds the extends expression directly.
          extendsName ??= bareTypeName(clause.text) || null;
        }
      }
    }

    const decorators = this.extractDecorators(node);
    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    if (body) {
      for (const member of body.children) {
        if (
          member.type === "method_definition" ||
          member.type === "public_field_definition"
        ) {
          if (member.type === "method_definition") {
            const methodName =
              member.childForFieldName("name")?.text ?? "anonymous";
            const params = this.extractJsParams(
              member.childForFieldName("parameters"),
            );
            const returnType = member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
            const isAsync = member.text.startsWith("async ");
            const methodBody = member.childForFieldName("body");
            const requestAccess = requestAccessOf(params, methodBody);
            // A URL-builder helper is as often a service-class method
            // (`configService.APIUrl(sub)`) as a free function.
            const templates = extractUrlTemplates(methodBody, new Set(params.map((p) => p.name)));
            methods.push({
              name: methodName,
              params,
              returnType,
              isAsync,
              isExported: false,
              decorators: this.extractDecorators(member),
              calls: [...extractCalls(methodBody, "typescript"), ...collectDynamicImportCalls(methodBody)],
              line: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
              ...urlTemplateFields(templates),
              ...(requestAccess ? { requestAccess } : {}),
            });
            // `constructor(public readonly id: number)` declares a property.
            if (methodName === "constructor") {
              properties.push(...this.parameterProperties(member.childForFieldName("parameters")));
            }
          } else {
            const propName =
              member.childForFieldName("name")?.text ?? "unknown";
            properties.push({
              name: propName,
              type: member.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null,
              visibility: this.getVisibility(member),
              isStatic: member.text.includes("static "),
              isReadonly: member.text.includes("readonly "),
              // Field decorators are children of the field (unlike a method's,
              // which sit beside it in the class body) — class-validator and
              // class-transformer markers live here.
              decorators: childDecorators(member),
              // `name?: string` or `age = 0` is not something a caller must send.
              isRequired: !hasOptionalMarker(member) && !member.childForFieldName("value"),
            });
          }
        }
      }
    }

    return {
      name,
      extends: extendsName,
      implements: implementsList,
      decorators,
      methods,
      properties,
      isExported,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  /**
   * TypeScript parameter properties: a constructor parameter carrying an
   * accessibility modifier or `readonly` declares a same-named property.
   */
  private parameterProperties(paramsNode: Node | null): PropertyInfo[] {
    if (!paramsNode) return [];
    const out: PropertyInfo[] = [];
    for (const param of paramsNode.namedChildren) {
      if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
      const modifier = param.children.find((c) => c.type === "accessibility_modifier")?.text ?? null;
      const isReadonly = param.children.some((c) => c.type === "readonly");
      if (!modifier && !isReadonly) continue;
      const name = param.childForFieldName("pattern")?.text;
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      out.push({
        name,
        type: param.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null,
        visibility: (modifier as "public" | "private" | "protected" | null) ?? "public",
        isStatic: false,
        isReadonly,
        decorators: childDecorators(param),
        isRequired: !hasOptionalMarker(param) && !param.childForFieldName("value"),
      });
    }
    return out;
  }

  private extractDecorators(node: Node): string[] {
    return extractJsDecorators(node);
  }

  private getVisibility(
    node: Node,
  ): "public" | "private" | "protected" | null {
    return getVisibility(node);
  }
}
