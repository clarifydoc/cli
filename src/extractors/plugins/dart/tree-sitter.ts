import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import type { ValueFlowFact } from "../../../types/analysis.js";
import type { TSNode } from "../../../parsers/parser-manager.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { callStep, nameCall, patternNamedCall, type CalleeStep } from "../shared/callee-names.js";
import { countSyntaxErrors, treeSitterReader } from "../shared/tree-sitter-front-end.js";
import { dartDiCallPatterns } from "./di.js";
import { fieldInitFacts, fileScopeOf, functionFacts, moduleFacts, type CallRefs, type ClassScope, type FileScope } from "./value-flow.js";

/** How many calls deep a chain is named (the linker types each step through declared return types). */
const CHAIN_DEPTH = 8;

/** Declarations whose bodies are no function's outside a member (field initializers). */
const TYPES: ReadonlySet<string> = new Set(["class_definition", "mixin_declaration", "extension_declaration", "extension_type_declaration", "enum_declaration"]);

/** A signature node that names a function as the Dart spec reads them; getters, setters and operators name none. */
const SIGNATURES: ReadonlySet<string> = new Set([
  "function_signature", "constructor_signature", "factory_constructor_signature", "redirecting_factory_constructor_signature",
  "constant_constructor_signature", "getter_signature", "setter_signature", "operator_signature",
]);

/** The Dart front end of the `tree-sitter:dart` feature, loaded on first use. */
export function loadDartReader(): Promise<(source: string) => ParsedStructure> {
  return treeSitterReader("dart", readDartTree);
}

interface Walk {
  text: string;
  topLevel: PatternCallName[];
  functions: Array<{
    span: Omit<ParsedFunctionSpan, "calls">;
    calls: PatternCallName[];
    /** What the value-flow reader needs: the signature, its declaration, the body and the class around. */
    shape: { sig: TSNode; decl: TSNode; body: TSNode | null; cls: ClassScope | null; isConstructor: boolean };
  }>;
  /** Each call by its argument list's node id, as named in the call list (the value-flow facts name calls so). */
  callRefs: CallRefs;
  file: FileScope;
}

/**
 * Dart's functions and calls from a tree-sitter-dart tree. A function is a top-level, member or local function, a
 * constructor (named by its class, a named or factory one by its own name, as the spec's patterns name them) or an
 * abstract signature, spanning its name's line to its body's end, and owns the calls in its body and initializer
 * list except those of a function declared inside it; a closure's calls are its owner's. Getters, setters and
 * operators are no functions, as the patterns read them. A call is named by the Dart spec's call patterns where one
 * reads its callee's text (a field path `this.squad.coach.brief(`, a container lookup `getIt<Repo>().find(`, a
 * generic call `context.read<Repo>(`), else as the patterns name a path (`repo.find(`, a cascade's bare `..add(`),
 * and one through a type's static member by every name (`PlayerService.instance.addPlayer(`), not its last two;
 * where they name nothing the parser still can: a method on a call's result is the chain from its first call, one
 * on a construction the type's (`Club(id: 1).save(` is `Club.save` on `Club`).
 */
export function readDartTree(root: TSNode, text: string): ParsedStructure {
  const topLevel: PatternCallName[] = [];
  const walk: Walk = { text, topLevel, functions: [], callRefs: new Map(), file: fileScopeOf(root, text) };
  visit(root, topLevel, walk, null);
  walk.functions.sort((a, b) => a.span.line - b.span.line);
  const classNodes = new Map<string, TSNode>();
  for (const c of namedChildren(root)) if (c.type === "class_definition") classNodes.set(c.childForFieldName("name")?.text ?? "", c);
  // A field's initializer (`late final cb = () => save();`) belongs to no function: its facts go on the class's
  // constructor, else its first member (the solver reads facts regardless of order).
  const initOwner = new Map<ClassScope, Walk["functions"][number]>();
  for (const f of walk.functions) {
    const cls = f.shape.cls;
    if (!cls) continue;
    const held = initOwner.get(cls);
    if (!held || (f.shape.isConstructor && !held.shape.isConstructor)) initOwner.set(cls, f);
  }
  const moduleFlow = moduleFacts(root, walk.file, walk.callRefs);
  return {
    functions: walk.functions.map((f) => {
      const { span, calls, shape } = f;
      let initFacts: ValueFlowFact[] | undefined;
      if (shape.cls && initOwner.get(shape.cls) === f) {
        const node = classNodes.get(shape.cls.name);
        initFacts = node ? fieldInitFacts(shape.cls, node, walk.file, walk.callRefs) : undefined;
      }
      const flow = functionFacts({ ...shape, ...(initFacts?.length ? { initFacts } : {}) }, walk.file, walk.callRefs);
      return {
        ...span,
        calls: recordPatternCalls(calls),
        ...(flow ? { valueFlow: flow.facts } : {}),
      };
    }),
    topLevelCalls: recordPatternCalls(topLevel),
    ...(moduleFlow.length ? { moduleValueFlow: moduleFlow } : {}),
    syntaxErrors: countSyntaxErrors(root),
  };
}

function namedChildren(node: TSNode): TSNode[] {
  const out: TSNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
}

/** The signature a declaration carries: itself, or the one a `method_signature` / `declaration` wraps. */
function signatureOf(node: TSNode): TSNode | null {
  if (SIGNATURES.has(node.type)) return node;
  if (node.type !== "method_signature" && node.type !== "declaration") return null;
  for (const child of namedChildren(node)) if (SIGNATURES.has(child.type)) return child;
  return null;
}

/** The name the spec's patterns give a function, and the node naming it; null for an accessor or operator. */
function functionName(sig: TSNode): TSNode | null {
  if (sig.type === "function_signature") return sig.childForFieldName("name");
  if (sig.type === "getter_signature" || sig.type === "setter_signature" || sig.type === "operator_signature") return null;
  // `A(…)` is named `A`; `A.named(…)` and `factory A.make(…)` by their own names.
  const names = namedChildren(sig).filter((c) => c.type === "identifier");
  return names.length >= 2 ? names[1]! : names[0] ?? null;
}

function visit(node: TSNode, owner: PatternCallName[] | null, walk: Walk, cls: ClassScope | null): void {
  const children = namedChildren(node);
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const sig = signatureOf(child);
    if (sig) {
      const body = children[i + 1]?.type === "function_body" ? children[i + 1]! : null;
      const name = functionName(sig);
      let calls = owner;
      if (name) {
        calls = [];
        const end = (body ?? child).endPosition.row + 1;
        const isConstructor = sig.type !== "function_signature";
        walk.functions.push({
          span: { name: name.text, line: name.startPosition.row + 1, endLine: end, ...(isConstructor ? { isConstructor: true as const } : {}) },
          calls,
          shape: { sig, decl: child, body, cls, isConstructor },
        });
      }
      // An initializer list (`: _repo = Repo()`) is the constructor's; its parameters call nothing.
      for (const part of namedChildren(child)) if (part !== sig) visit(part, calls, walk, cls);
      if (body) {
        visit(body, calls, walk, cls);
        i++;
      }
      continue;
    }
    if (TYPES.has(child.type)) {
      const name = child.childForFieldName("name") ?? namedChildren(child).find((c) => c.type === "identifier");
      visit(child, owner === walk.topLevel ? null : owner, walk, (name && child.type === "class_definition" ? walk.file.classes.get(name.text) : null) ?? null);
      continue;
    }
    if (!isSelector(child) && children[i + 1] && isSelector(children[i + 1]!)) {
      i = readRun(children, i, owner, walk, cls);
      continue;
    }
    // `: super(key: key)` / `: this(0)`: the constructor it calls, as the patterns read `super(`.
    if (owner && (child.type === "super" || child.type === "this") && children[i + 1]?.type === "arguments") {
      owner.push({ name: child.type, leafName: child.type, line: child.startPosition.row + 1, column: child.startPosition.column });
    }
    if (owner && child.type === "cascade_section") cascadeCall(child, owner);
    if (owner && (child.type === "const_object_expression" || child.type === "new_expression")) {
      const named = constructionName(child);
      if (named) owner.push(named);
      const args = namedChildren(child).find((c) => c.type === "arguments");
      if (named && args) registerCall(walk, owner, args, named);
    }
    visit(child, owner, walk, cls);
  }
}

/** A step after a primary; after `super` the grammar leaves the member unwrapped (`super.initState()`). */
const isSelector = (node: TSNode): boolean =>
  node.type === "selector" || node.type === "unconditional_assignable_selector" || node.type === "conditional_assignable_selector";

const idStep = (name: string, node: TSNode): CalleeStep => ({ kind: "id", name, line: node.startPosition.row + 1, column: node.startPosition.column });

/** The first steps of a run: a name, `this`/`super`, or a receiver no name spells (a string's methods read bare). */
function primarySteps(node: TSNode): CalleeStep[] {
  if (node.type === "identifier") return [idStep(node.text, node)];
  if (node.type === "this") return [idStep("this", node)];
  if (node.type === "super") return [idStep("super", node)];
  // A dot shorthand `.delayed(…)` names the member alone (also how the grammar ends `Future<void>.delayed(…)`).
  const member = node.type === "dot_shorthand" ? node.namedChild(0) : null;
  if (member?.type === "identifier") return [{ kind: "other", bare: true }, idStep(member.text, member)];
  return [{ kind: "other", bare: node.type === "string_literal" }];
}

/**
 * A primary and the selectors after it (`repo`, `.find`, `(id)`, `.first`, `()`): each argument list is a call of
 * what comes before it. Returns the index of the run's last selector.
 */
function readRun(children: TSNode[], start: number, owner: PatternCallName[] | null, walk: Walk, cls: ClassScope | null): number {
  const primary = children[start]!;
  let steps: CalleeStep[] = primarySteps(primary);
  if (primary.type === "const_object_expression" || primary.type === "new_expression") {
    // `const Pipeline().addMiddleware(…)`: a method on the construction is the type's.
    const named = constructionName(primary);
    if (named && owner) owner.push(named);
    const ctorArgs = namedChildren(primary).find((c) => c.type === "arguments");
    if (named && ctorArgs) registerCall(walk, owner, ctorArgs, named);
    const type = named?.name.split(".")[0];
    if (type) steps = [idStep(type, primary), { kind: "call", constructs: type }];
  }
  if (steps[0]!.kind === "other" || steps.length > 1) visit(primary, owner, walk, cls);
  let i = start + 1;
  for (; i < children.length && isSelector(children[i]!); i++) {
    const selector = children[i]!;
    const part = selector.type === "selector" ? selector.namedChild(0) : selector;
    if (!part) continue; // `!`: a null assertion calls through.
    if (part.type === "argument_part") {
      const args = namedChildren(part).find((c) => c.type === "arguments");
      if (owner) {
        const source = `${walk.text.slice(primary.startIndex, args?.startIndex ?? part.startIndex)}(`;
        const at = primary.startPosition;
        const byPattern = patternNamedCall(source, dartDiCallPatterns, at.row + 1, at.column);
        let named = byPattern === undefined ? nameCall(steps, CHAIN_DEPTH, { paths: true }) : byPattern;
        // `handlers['save']!(…)`, `hs[0](…)`: a call of a collection's element, named for the collection.
        if (!named && steps.length === 2 && steps[0]!.kind === "id" && steps[1]!.kind === "other" && !steps[1]!.bare && primary.type === "identifier" && indexRun(children, start + 1, i)) {
          named = { name: `${primary.text}[]`, leafName: `${primary.text}[]`, line: primary.startPosition.row + 1, column: primary.startPosition.column };
        }
        if (named) {
          owner.push(named);
          if (args) registerCall(walk, owner, args, named);
        }
      }
      steps.push(callStep(steps));
      visit(part, owner, walk, cls);
      continue;
    }
    const member = part.namedChild(0);
    if ((part.type === "unconditional_assignable_selector" || part.type === "conditional_assignable_selector") && member?.type === "identifier") {
      steps.push(idStep(member.text, member));
    } else {
      steps.push({ kind: "other", bare: false });
      visit(selector, owner, walk, cls);
    }
  }
  return i - 1;
}

/** `..add(x)`: the cascade's method, read bare as the patterns read it. */
function cascadeCall(section: TSNode, owner: PatternCallName[]): void {
  const parts = namedChildren(section);
  const name = parts.find((p) => p.type === "cascade_selector")?.namedChild(0);
  if (name?.type !== "identifier" || !parts.some((p) => p.type === "argument_part")) return;
  owner.push({ name: name.text, leafName: name.text, line: name.startPosition.row + 1, column: name.startPosition.column });
}

/** `const Club(…)`, `new Club.named(…)`: the type, and the named constructor after it. */
function constructionName(node: TSNode): PatternCallName | null {
  const parts = namedChildren(node);
  const type = parts.find((p) => p.type === "type_identifier");
  if (!type) return null;
  const ctor = parts.find((p) => p.type === "identifier");
  const name = ctor ? `${type.text}.${ctor.text}` : type.text;
  return { name, leafName: ctor?.text ?? type.text, line: type.startPosition.row + 1, column: type.startPosition.column };
}

/** Whether the selectors from `from` up to the call at `at` are one index (and null assertions): `[key]!`. */
function indexRun(children: TSNode[], from: number, at: number): boolean {
  let indexes = 0;
  for (let k = from; k < at; k++) {
    const sel = children[k]!;
    if (sel.type === "selector" && sel.namedChildCount === 0) continue;
    const part = sel.type === "selector" ? sel.namedChild(0) : sel;
    if (part?.namedChild(0)?.type === "index_selector") indexes++;
    else return false;
  }
  return indexes === 1;
}

/**
 * Remember which call an argument list is. The call list keeps one call per name per function, at the first
 * occurrence's line, so a later call of the same name states its facts there.
 */
function registerCall(walk: Walk, owner: PatternCallName[] | null, args: TSNode, named: PatternCallName): void {
  const first = owner?.find((c) => c.name === named.name);
  walk.callRefs.set(args.id, { name: named.name, line: first?.line ?? named.line });
}
