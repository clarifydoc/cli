import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact } from "../../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../../types/project.js";

/**
 * ASP.NET custom routing attributes — a project's own `[V3ApiController]`
 * (an `IRouteTemplateProvider` whose constructor builds
 * `Template = $"api/v{version}/{resource}"`) or `[RestPutById]`
 * (`: HttpPutAttribute` with `base("{id:int?}")`).
 *
 * ASP.NET reads the template and verbs from the attribute INSTANCE, so what a
 * use site means depends on a class usually declared in another file, its
 * constructor's parameter defaults and the arguments its `base(…)` call
 * passes up the chain. Per file, the extractor records each attribute class
 * as a small expression IR (`cs:attr-def`); the project pass evaluates a use
 * site's arguments through that chain. Anything the IR cannot express — a
 * method call, a `this(…)` chain, a named constructor argument — evaluates to
 * unknown, and an unknown template is never guessed.
 */

export const CS_ATTR_DEF_FACT = "cs:attr-def";

/** A C# expression reduced to what a route template can be built from. `null` = not expressible. */
export type CsExpr =
  | { s: string }
  | { n: string }
  | { ref: string }
  | { interp: Array<string | CsExpr> }
  | { cat: CsExpr[] }
  | { arr: CsExpr[] };

export interface CsAttrCtor {
  params: Array<{ name: string; hasDefault: boolean; def: CsExpr | null }>;
  /** Positional arguments of `: base(…)`; absent when the constructor calls no base constructor. */
  base?: Array<CsExpr | null>;
  /** The constructor chains in a way the IR cannot follow (`: this(…)`, named base arguments). */
  opaque?: true;
  /** `Template = …` / `this.Version = …`, in statement order. */
  assigns: Array<[string, CsExpr | null]>;
}

export interface CsAttrDefFact {
  /** The base list as written, base class first. */
  bases: string[];
  ctors: CsAttrCtor[];
  /** `Template => "x"`, `Template { get; } = "x"`, `get { return "x"; }`. */
  props: Record<string, CsExpr | null>;
  /** `const` and `static readonly` fields. */
  consts: Record<string, CsExpr | null>;
}

/** An attribute applied at a use site, with its positional arguments. */
export interface CsAttrUse {
  name: string;
  args: Array<CsExpr | null>;
  line: number;
}

/** `class XAttribute : …` that may carry routing — anything deriving from more than plain `Attribute`. */
export function attributeDefFact(cls: Node, name: string, bases: string[], facts: RouteFact[]): void {
  if (!/Attribute$/.test(name) || bases.length === 0) return;
  if (bases.every((b) => b === "Attribute" || b === "System.Attribute")) return;
  const body = cls.childForFieldName("body") ?? cls.children.find((c) => c.type === "declaration_list");
  if (!body) return;
  const data: CsAttrDefFact = { bases, ctors: [], props: {}, consts: {} };
  for (const member of body.namedChildren) {
    if (member.type === "constructor_declaration") data.ctors.push(constructorOf(member));
    else if (member.type === "property_declaration") {
      const prop = member.childForFieldName("name")?.text;
      const value = propertyValue(member);
      if (prop && value !== undefined) data.props[prop] = value;
    } else if (member.type === "field_declaration") {
      const mods = member.children.filter((c) => c.type === "modifier").map((c) => c.text);
      if (!mods.includes("const") && !(mods.includes("static") && mods.includes("readonly"))) continue;
      const decl = member.namedChildren.find((c) => c.type === "variable_declaration");
      for (const v of decl?.namedChildren ?? []) {
        if (v.type !== "variable_declarator") continue;
        const id = v.namedChildren.find((c) => c.type === "identifier");
        const init = v.namedChildren[v.namedChildren.length - 1];
        if (id && init && init !== id) data.consts[id.text] = csExpr(init);
      }
    }
  }
  facts.push({ kind: CS_ATTR_DEF_FACT, line: cls.startPosition.row + 1, owner: name, data });
}

function constructorOf(ctor: Node): CsAttrCtor {
  const out: CsAttrCtor = { params: [], assigns: [] };
  const params = ctor.childForFieldName("parameters") ?? ctor.namedChildren.find((c) => c.type === "parameter_list");
  for (const p of params?.namedChildren ?? []) {
    if (p.type !== "parameter") continue;
    const name = p.childForFieldName("name")?.text;
    if (!name) continue;
    const eq = p.children.findIndex((c) => c.type === "=");
    const defNode = eq >= 0 ? p.children[eq + 1] : undefined;
    out.params.push({ name, hasDefault: eq >= 0, def: defNode ? csExpr(defNode) : null });
  }
  const init = ctor.namedChildren.find((c) => c.type === "constructor_initializer");
  if (init) {
    const args = init.namedChildren.find((c) => c.type === "argument_list");
    const named = (args?.namedChildren ?? []).some((a) => a.namedChildren.some((c) => c.type === "name_colon"));
    if (init.children.some((c) => c.type === "this") || named) out.opaque = true;
    else out.base = (args?.namedChildren ?? []).filter((a) => a.type === "argument").map((a) => (a.namedChildren[0] ? csExpr(a.namedChildren[0]) : null));
  }
  const body = ctor.childForFieldName("body") ?? ctor.namedChildren.find((c) => c.type === "block");
  for (const stmt of body?.namedChildren ?? []) {
    const expr = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
    if (expr?.type !== "assignment_expression") continue;
    if (!expr.children.some((c) => c.type === "=")) continue;
    const left = expr.childForFieldName("left") ?? expr.namedChildren[0];
    const right = expr.childForFieldName("right") ?? expr.namedChildren[expr.namedChildren.length - 1];
    const target = left ? memberName(left) : null;
    if (target && right) out.assigns.push([target, csExpr(right)]);
  }
  // An expression-bodied constructor (`=> Template = "x";`).
  const arrow = ctor.namedChildren.find((c) => c.type === "arrow_expression_clause")?.namedChildren[0];
  if (arrow?.type === "assignment_expression") {
    const target = arrow.namedChildren[0] ? memberName(arrow.namedChildren[0]) : null;
    const right = arrow.namedChildren[arrow.namedChildren.length - 1];
    if (target && right) out.assigns.push([target, csExpr(right)]);
  }
  return out;
}

/** `Template` / `this.Template` → "Template". */
function memberName(node: Node): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "member_access_expression" && node.namedChildren[0]?.type === "this_expression") {
    return node.childForFieldName("name")?.text ?? null;
  }
  if (node.type === "member_access_expression" && node.children[0]?.type === "this") {
    return node.childForFieldName("name")?.text ?? node.namedChildren[node.namedChildren.length - 1]?.text ?? null;
  }
  return null;
}

/** A property's value, or undefined when it has none the IR could state (an auto-property set elsewhere). */
function propertyValue(prop: Node): CsExpr | null | undefined {
  const arrow = prop.namedChildren.find((c) => c.type === "arrow_expression_clause");
  if (arrow) return arrow.namedChildren[0] ? csExpr(arrow.namedChildren[0]) : null;
  const eq = prop.children.findIndex((c) => c.type === "=");
  if (eq >= 0 && prop.children[eq + 1]) return csExpr(prop.children[eq + 1]!);
  const accessors = prop.namedChildren.find((c) => c.type === "accessor_list");
  for (const acc of accessors?.namedChildren ?? []) {
    if (!acc.children.some((c) => c.type === "get")) continue;
    const accArrow = acc.namedChildren.find((c) => c.type === "arrow_expression_clause");
    if (accArrow) return accArrow.namedChildren[0] ? csExpr(accArrow.namedChildren[0]) : null;
    const block = acc.namedChildren.find((c) => c.type === "block");
    const stmts = block?.namedChildren.filter((c) => c.type !== "comment") ?? [];
    if (stmts.length === 1 && stmts[0]!.type === "return_statement") {
      const value = stmts[0]!.namedChildren[0];
      return value ? csExpr(value) : null;
    }
    if (block) return null;
  }
  return undefined;
}

/** The IR form of an expression, or null when it is not one a template can be built from. */
export function csExpr(node: Node): CsExpr | null {
  switch (node.type) {
    case "string_literal":
    case "verbatim_string_literal": {
      const content = node.namedChildren.filter((c) => c.type === "string_literal_content" || c.type === "escape_sequence");
      return { s: content.length > 0 ? content.map((c) => c.text).join("") : node.text.replace(/^@?"/, "").replace(/"$/, "") };
    }
    case "integer_literal":
    case "real_literal":
      return { n: node.text.replace(/[fFdDmMlLuU]+$/, "") };
    case "identifier":
      return { ref: node.text };
    case "member_access_expression": {
      const name = memberName(node);
      if (name) return { ref: name };
      return /^[A-Za-z_][\w.]*$/.test(node.text) ? { ref: node.text } : null;
    }
    case "parenthesized_expression":
      return node.namedChildren[0] ? csExpr(node.namedChildren[0]) : null;
    case "interpolated_string_expression": {
      const parts: Array<string | CsExpr> = [];
      for (const c of node.namedChildren) {
        if (c.type === "string_content" || c.type === "escape_sequence") parts.push(c.text);
        else if (c.type === "interpolation") {
          const inner = c.namedChildren.find(
            (x) => x.type !== "interpolation_brace" && x.type !== "interpolation_alignment_clause" && x.type !== "interpolation_format_clause",
          );
          if (!inner || c.namedChildren.some((x) => x.type === "interpolation_format_clause")) return null;
          const e = csExpr(inner);
          if (!e) return null;
          parts.push(e);
        } else if (c.type !== "interpolation_start" && c.type !== "interpolation_quote") return null;
      }
      return { interp: parts };
    }
    case "binary_expression": {
      if (!node.children.some((c) => c.type === "+")) return null;
      const l = node.namedChildren[0] ? csExpr(node.namedChildren[0]) : null;
      const r = node.namedChildren[1] ? csExpr(node.namedChildren[1]) : null;
      if (!l || !r) return null;
      return { cat: [...("cat" in l ? l.cat : [l]), r] };
    }
    case "implicit_array_creation_expression":
    case "array_creation_expression":
    case "collection_expression": {
      const init = node.type === "collection_expression" ? node : node.namedChildren.find((c) => c.type === "initializer_expression");
      if (!init) return null;
      const items: CsExpr[] = [];
      for (const el of init.namedChildren) {
        const e = csExpr(el.type === "expression_element" && el.namedChildren[0] ? el.namedChildren[0] : el);
        if (!e) return null;
        items.push(e);
      }
      return { arr: items };
    }
    case "invocation_expression": {
      // nameof(X.Y) → "Y"
      const fn = node.childForFieldName("function") ?? node.namedChildren[0];
      if (fn?.text !== "nameof") return null;
      const arg = node.namedChildren.find((c) => c.type === "argument_list")?.namedChildren[0];
      return arg ? { s: arg.text.replace(/.*\./, "") } : null;
    }
    default:
      return null;
  }
}

/** Positional arguments of an attribute use (`[V3ApiController("movie")]` → `[{s:"movie"}]`). */
export function attributeUse(attr: Node, name: string): CsAttrUse {
  const args: Array<CsExpr | null> = [];
  const list = attr.namedChildren.find((c) => c.type === "attribute_argument_list");
  for (const arg of list?.namedChildren ?? []) {
    if (arg.type !== "attribute_argument") continue;
    // `Name = "x"` sets a property; `name: x` names a constructor parameter the IR does not bind.
    if (arg.children.some((c) => c.type === "=")) continue;
    if (arg.namedChildren.some((c) => c.type === "name_colon")) {
      args.push(null);
      continue;
    }
    const value = arg.namedChildren[arg.namedChildren.length - 1];
    args.push(value ? csExpr(value) : null);
  }
  return { name, args, line: attr.startPosition.row + 1 };
}

// ─── Project pass: what a use site means ───────────────────────────────────

type Val = string | string[] | null;

/** What an attribute instance contributes to routing. */
export interface AttrMeaning {
  /** The route template it provides, tokens unresolved; null when it provides none. */
  template: string | null;
  /** It provides a template, but the evaluation could not say which. */
  templateUnknown: boolean;
  /** HTTP verbs it constrains the action to. */
  verbs: string[];
  /** It turns on `[ApiController]` behaviour (`IApiBehaviorMetadata`). */
  apiController: boolean;
}

interface AttrState {
  props: Map<string, Val>;
  verbs: string[] | null;
  /** Template from a framework base constructor (`HttpPutAttribute("{id}")`). */
  frameworkTemplate: Val | undefined;
  templateProvider: boolean;
  verbProvider: boolean;
  apiController: boolean;
  /** Some link of the chain could not be evaluated. */
  unknown: boolean;
}

const FRAMEWORK_VERB_ATTRS: Record<string, string> = {
  HttpGetAttribute: "GET",
  HttpPostAttribute: "POST",
  HttpPutAttribute: "PUT",
  HttpPatchAttribute: "PATCH",
  HttpDeleteAttribute: "DELETE",
  HttpHeadAttribute: "HEAD",
  HttpOptionsAttribute: "OPTIONS",
};

const bare = (written: string): string => written.replace(/<.*$/, "").replace(/.*\./, "");

/**
 * Evaluates attribute uses against the project's `cs:attr-def` facts. Built
 * once per resolver run; memoizes per (class, arguments).
 */
export class CustomAttributes {
  private readonly defs = new Map<ClassRef, CsAttrDefFact>();
  private readonly memo = new Map<string, AttrMeaning | null>();

  constructor(
    analyses: FileAnalysis[],
    private readonly ctx: ProjectContext,
  ) {
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== CS_ATTR_DEF_FACT || !f.owner) continue;
        const ref = ctx.classes.classesIn(a.filePath).find((c) => c.cls.name === f.owner);
        if (ref) this.defs.set(ref, f.data as CsAttrDefFact);
      }
    }
  }

  get empty(): boolean {
    return this.defs.size === 0;
  }

  /**
   * What `[name(args)]` used in `fromFile` means for routing, or null when it
   * names no project attribute that routes (a framework or third-party
   * attribute, a filter, a marker).
   */
  meaning(fromFile: string, use: CsAttrUse): AttrMeaning | null {
    if (this.defs.size === 0) return null;
    const ref =
      this.ctx.classes.resolve(fromFile, `${use.name}Attribute`) ?? (/Attribute$/.test(use.name) ? this.ctx.classes.resolve(fromFile, use.name) : null);
    if (!ref || !this.defs.has(ref)) return null;
    const key = `${ref.filePath}\0${ref.cls.name}\0${JSON.stringify(use.args)}`;
    if (this.memo.has(key)) return this.memo.get(key)!;
    const args = use.args.map((a) => (a ? this.eval(a, () => null) : null));
    const state = this.instantiate(ref, args, 0);
    let result: AttrMeaning | null = null;
    if (state && (state.templateProvider || state.verbProvider || state.apiController)) {
      const tmpl = state.frameworkTemplate !== undefined ? state.frameworkTemplate : state.templateProvider ? (state.props.get("Template") ?? null) : null;
      const providesTemplate = state.templateProvider || state.frameworkTemplate !== undefined;
      const known = typeof tmpl === "string";
      result = {
        template: known ? tmpl : null,
        // A framework verb attribute without a template argument provides none — that is known.
        templateUnknown: providesTemplate && !known && !(state.frameworkTemplate === null && !state.unknown),
        verbs: state.verbs ?? [],
        apiController: state.apiController,
      };
    }
    this.memo.set(key, result);
    return result;
  }

  /** Construct `ref` with evaluated `args`: pick the constructor, run its base chain, then its body. */
  private instantiate(ref: ClassRef, args: Val[], depth: number): AttrState | null {
    const def = this.defs.get(ref);
    if (!def || depth > 6) return null;
    const state: AttrState = {
      props: new Map(),
      verbs: null,
      frameworkTemplate: undefined,
      templateProvider: false,
      verbProvider: false,
      apiController: false,
      unknown: false,
    };

    // Constructor: the one the arguments fit, preferring an exact arity.
    let ctor: CsAttrCtor | null = null;
    if (def.ctors.length === 0) {
      if (args.length > 0) return null;
      ctor = { params: [], assigns: [] };
    } else {
      const fits = def.ctors.filter((c) => c.params.length >= args.length && c.params.slice(args.length).every((p) => p.hasDefault));
      const exact = fits.filter((c) => c.params.length === args.length);
      ctor = fits.length === 1 ? fits[0]! : exact.length === 1 ? exact[0]! : null;
      if (!ctor) return null;
    }

    const consts = (name: string): Val | undefined => {
      const key = name.replace(/.*\./, "");
      const expr = this.constOf(ref, key, 0);
      return expr === undefined ? undefined : expr ? this.eval(expr, () => undefined) : null;
    };
    const env = new Map<string, Val>();
    ctor.params.forEach((p, i) => {
      env.set(p.name, i < args.length ? args[i]! : p.def ? this.eval(p.def, consts) : null);
    });
    const lookup = (name: string): Val | undefined => (env.has(name) ? env.get(name)! : state.props.has(name) ? state.props.get(name)! : consts(name));

    // Base chain.
    const baseWritten = def.bases[0]!;
    const baseName = bare(baseWritten);
    const baseArgs = ctor.base?.map((a) => (a ? this.eval(a, lookup) : null)) ?? [];
    if (ctor.opaque) state.unknown = true;
    if (FRAMEWORK_VERB_ATTRS[baseName]) {
      state.verbs = [FRAMEWORK_VERB_ATTRS[baseName]!];
      state.verbProvider = true;
      state.frameworkTemplate = baseArgs.length > 0 ? baseArgs[0]! : null;
      if (baseArgs.length > 0 && typeof baseArgs[0] !== "string") state.unknown = true;
    } else if (baseName === "HttpMethodAttribute") {
      const verbs = baseArgs[0];
      state.verbs = Array.isArray(verbs) ? verbs.map((v) => v.toUpperCase()) : typeof verbs === "string" ? [verbs.toUpperCase()] : [];
      state.verbProvider = true;
      state.frameworkTemplate = baseArgs.length > 1 ? baseArgs[1]! : null;
      if (!Array.isArray(verbs) && typeof verbs !== "string") state.unknown = true;
    } else if (baseName === "RouteAttribute") {
      state.templateProvider = true;
      state.frameworkTemplate = baseArgs[0] ?? null;
    } else if (baseName !== "Attribute") {
      const st = this.ctx.classes.supertypes(ref).find((s) => s.written === baseWritten);
      const inherited = st?.ref ? this.instantiate(st.ref, baseArgs, depth + 1) : null;
      if (inherited) {
        for (const [k, v] of inherited.props) state.props.set(k, v);
        state.verbs = inherited.verbs;
        state.frameworkTemplate = inherited.frameworkTemplate;
        state.templateProvider = inherited.templateProvider;
        state.verbProvider = inherited.verbProvider;
        state.apiController = inherited.apiController;
        state.unknown ||= inherited.unknown;
      } else if (!/^I[A-Z]/.test(baseName)) {
        // A base attribute this project does not declare: whatever it sets is unknown.
        state.unknown = true;
      }
    }

    // Interfaces anywhere in the base list.
    for (const b of def.bases.map(bare)) {
      if (b === "IRouteTemplateProvider") state.templateProvider = true;
      else if (b === "IActionHttpMethodProvider") state.verbProvider = true;
      else if (b === "IApiBehaviorMetadata") state.apiController = true;
    }

    // Constructor body, then this class's own property values.
    for (const [name, expr] of ctor.assigns) {
      const v = expr ? this.eval(expr, lookup) : null;
      state.props.set(name, v);
    }
    for (const [name, expr] of Object.entries(def.props)) {
      if (ctor.assigns.some(([n]) => n === name)) continue;
      state.props.set(name, expr ? this.eval(expr, (n) => (state.props.has(n) ? state.props.get(n)! : consts(n))) : null);
    }
    if (state.verbProvider && state.props.has("HttpMethods")) {
      const v = state.props.get("HttpMethods");
      state.verbs = Array.isArray(v) ? v.map((x) => x.toUpperCase()) : typeof v === "string" ? [v.toUpperCase()] : null;
      if (state.verbs === null) state.unknown = true;
    }
    return state;
  }

  /** A `const` declared on the class or one of its attribute ancestors. */
  private constOf(ref: ClassRef, name: string, depth: number): CsExpr | null | undefined {
    const def = this.defs.get(ref);
    if (!def || depth > 6) return undefined;
    if (Object.prototype.hasOwnProperty.call(def.consts, name)) return def.consts[name] ?? null;
    const st = this.ctx.classes.supertypes(ref).find((s) => s.written === def.bases[0]);
    return st?.ref ? this.constOf(st.ref, name, depth + 1) : undefined;
  }

  private eval(expr: CsExpr, lookup: (name: string) => Val | undefined): Val {
    if ("s" in expr) return expr.s;
    if ("n" in expr) return expr.n;
    if ("ref" in expr) return lookup(expr.ref) ?? null;
    if ("arr" in expr) {
      const out: string[] = [];
      for (const item of expr.arr) {
        const v = this.eval(item, lookup);
        if (typeof v !== "string") return null;
        out.push(v);
      }
      return out;
    }
    const parts = "interp" in expr ? expr.interp : expr.cat;
    let out = "";
    for (const p of parts) {
      const v = typeof p === "string" ? p : this.eval(p, lookup);
      if (typeof v !== "string") return null;
      out += v;
    }
    return out;
  }
}
