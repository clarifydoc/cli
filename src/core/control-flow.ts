import type { Language } from "../types/analysis.js";
import type { TSTree } from "../parsers/parser-manager.js";
import type {
  ControlFlowField,
  ControlFlowRole,
  LanguageComplexitySpec,
  LanguageControlFlowSpec,
} from "../types/language-plugin.js";
import type { Cfg, CfgEdge, CfgNode, CfgNodeKind, FlowNode } from "../types/control-flow.js";
import { complexityFor, controlFlowFor, pluginFor } from "../extractors/registry.js";
import { DEFAULT_COMPLEXITY } from "../extractors/shared/complexity-defaults.js";
import {
  DEFAULT_CONTROL_FLOW_FIELDS,
  DEFAULT_WILDCARD_LABELS,
} from "../extractors/shared/control-flow-defaults.js";
import { findBodyNode, makeEndRowMemo } from "./complexity-analyzer.js";

/**
 * Build a control-flow graph for one function body.
 *
 * This is the structure behind the complexity number. `complexity-analyzer.ts`
 * walks a body counting branch nodes and throws the walk away; this walks the
 * same body — via the same `findBodyNode` — and keeps it, so a reader who is
 * told "cognitive complexity 47" can be shown *where*.
 *
 * It is a structured-statement interpreter, not a general CFG construction:
 * every language it targets nests its control flow, so sequencing a body is a
 * recursion over statements with a stack of `break`/`continue` targets. What
 * each node type *does* comes from the language's `LanguageControlFlowSpec`
 * (`meta.controlFlow`) — core names no node type of its own.
 *
 * Two deliberate approximations, both visible in the output rather than
 * silently applied:
 *
 *  - **`finally` on an abnormal exit is drawn as a detour, not a rewrite.** A
 *    `return` inside a guarded `try` runs the `finally` before it leaves. The
 *    `return` keeps its own edge to the exit and gains a dotted `unwind` edge
 *    into the `finally`; what the graph does not show is that control then
 *    resumes leaving rather than falling through to the statement after the
 *    `try`. Modelling that exactly means duplicating the `finally` once per
 *    exit path, which inflates both the diagram and the complexity read off
 *    it. `Cfg.hasFinally` tells the renderer to say so.
 *  - **Any statement can raise, not just `throw`.** Drawing an edge from every
 *    statement to every enclosing `catch` would bury the diagram, so the graph
 *    draws one edge from the head of a guarded region plus the real edges from
 *    explicit `throw`s.
 *
 * What it will not do is drop an edge. A node type the spec gives no role
 * becomes a plain `STATEMENT` and is recorded in `Cfg.unmodelled` — an
 * unmodelled node is something a reader can see and discount, a missing edge
 * is not.
 */

/** Longest label kept before the middle is elided. */
const MAX_LABEL = 64;

/** A dangling exit waiting to be connected to whatever comes next. */
interface Pending {
  id: string;
  label?: string;
  back?: boolean;
}

/**
 * An open `try`. `handler` is live only while the guarded block itself is being
 * emitted — a `throw` inside a `catch` is not caught by its own `try` — whereas
 * `unwinds` stays open across the `catch` clauses too, because a `return` from
 * one of them still runs the `finally`.
 */
interface Guard {
  /**
   * Where a `throw` in the guarded block goes: the FIRST `catch` clause, which
   * is the one the runtime tests first. Absent for a bare `try`/`finally`, and
   * cleared once the guarded block has been emitted.
   */
  handler?: string;
  /**
   * Jumps that leave this region, collected so they can be drawn running its
   * `finally` on the way out. Absent when the `try` has no `finally`.
   */
  unwinds?: Pending[];
}

/** A `break`/`continue` target: a loop, or a switch (which only `break` exits). */
interface JumpFrame {
  kind: "loop" | "switch";
  label?: string;
  /** Where `continue` jumps; absent for a switch. */
  continueTarget?: string;
  /** Exits collected from `break` statements, connected after the construct. */
  breaks: Pending[];
}

/**
 * The function to draw, identified the way the complexity analyzer lists it:
 * by name and by the 1-based line range of its declaration.
 */
export interface FunctionRef {
  /** As reported by the complexity analyzer — `Class.method` for methods. */
  name: string;
  line: number;
  endLine: number;
}

/** Whitespace-collapse a label and cut it at `MAX_LABEL` with an ellipsis. */
function collapse(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= MAX_LABEL) return one;
  return `${one.slice(0, MAX_LABEL - 1)}…`;
}

/**
 * Accumulates the nodes and edges of one function's graph while the statement
 * walker visits its body.
 *
 * It owns the graph primitives (`add`, `connect`), the stack of open loops and
 * switches that `break`/`continue` resolve against (`jumps`), the open
 * `try`/`finally` regions that returns and throws must route through
 * (`guards`), and the running counts the final `Cfg` reports: constructs the
 * tables do not model and branches nothing reaches.
 */
class Builder {
  readonly nodes: CfgNode[] = [];
  readonly edges: CfgEdge[] = [];
  readonly unmodelled = new Set<string>();
  hasFinally = false;
  /** Branches in statements nothing reaches. See `Cfg.unreachableBranches`. */
  unreachableBranches = 0;

  private seq = 0;
  private readonly jumps: JumpFrame[] = [];
  /** Open guarded regions, innermost last. See `Guard`. */
  private readonly guards: Guard[] = [];
  /** Label attached to the statement about to be emitted, if any. */
  private pendingLabel?: string;

  readonly entryId: string;
  readonly exitId: string;

  constructor(
    private readonly spec: LanguageControlFlowSpec,
    private readonly complexity: LanguageComplexitySpec,
    private readonly fields: Record<ControlFlowField, readonly string[]>,
    functionName: string,
    declLine: number,
    lastLine: number,
  ) {
    this.entryId = this.add("ENTRY", functionName, undefined, declLine, declLine, 0);
    this.exitId = this.add("EXIT", "end", undefined, lastLine, lastLine, 0);
  }

  // ── graph primitives ───────────────────────────────────────────────────

  private add(
    kind: CfgNodeKind,
    label: string,
    nodeType: string | undefined,
    line: number,
    endLine: number,
    inlineBranches: number,
  ): string {
    const id = `n${this.seq++}`;
    this.nodes.push({ id, kind, label, nodeType, line, endLine, inlineBranches });
    return id;
  }

  /** Emit a node for a source construct, deriving its span and label. */
  private node(kind: CfgNodeKind, label: string, src: FlowNode, inline: number): string {
    return this.add(
      kind,
      collapse(label),
      src.type,
      src.startPosition.row + 1,
      src.endPosition.row + 1,
      inline,
    );
  }

  private edge(from: string, to: string, label?: string, back?: boolean): void {
    const e: CfgEdge = { from, to };
    if (label !== undefined) e.label = label;
    if (back) e.back = true;
    this.edges.push(e);
  }

  /** Connect every dangling exit to `to`, carrying each one's own label. */
  private connect(pending: Pending[], to: string): void {
    for (const p of pending) this.edge(p.id, to, p.label, p.back);
  }

  /**
   * The first node created while `run` executed — the entry of whatever it
   * emitted. Cheaper and less invasive than threading an entry id back out of
   * every emit, and exact: nodes are only ever appended.
   */
  private entryOf<T>(run: () => T): { entry: string | undefined; result: T } {
    const mark = this.nodes.length;
    const result = run();
    return { entry: this.nodes[mark]?.id, result };
  }

  // ── spec lookups ───────────────────────────────────────────────────────

  private role(n: FlowNode): ControlFlowRole | undefined {
    const declared = this.spec.roles.get(n.type);
    if (declared !== undefined) return declared;
    return this.spec.ignorePattern?.test(n.type) === true ? "ignore" : undefined;
  }

  private field(n: FlowNode, part: ControlFlowField): FlowNode | null {
    for (const name of this.fields[part]) {
      const hit = n.childForFieldName(name);
      if (hit) return hit;
    }
    // No field of that name: fall back to the position the language declared.
    const at = this.spec.shapes?.[n.type]?.[part];
    if (at === undefined) return null;
    const named = this.named(n);
    return (at < 0 ? named[named.length + at] : named[at]) ?? null;
  }

  /**
   * Every child carrying one of a part's field names, in source order.
   *
   * Most grammars give a node at most one `alternative`, but Python and PHP
   * flatten an `elif` chain into a list of them on the one `if`, so reading
   * only the first would silently drop every branch after the first `elif`.
   */
  private fieldAll(n: FlowNode, part: ControlFlowField): FlowNode[] {
    const names = new Set(this.fields[part]);
    const out: FlowNode[] = [];
    for (let i = 0; i < n.childCount; i++) {
      const name = n.fieldNameForChild(i);
      if (name === null || !names.has(name)) continue;
      const child = n.child(i);
      if (child?.isNamed) out.push(child);
    }
    if (out.length > 0) return out;
    // A grammar that names no fields declares the position instead; there is
    // only ever one alternative in that form.
    const positional = this.field(n, part);
    return positional ? [positional] : [];
  }

  private named(n: FlowNode): FlowNode[] {
    return n.children.filter((c) => c.isNamed);
  }

  /**
   * The `else` of a loop or a `try` — Python's "the body finished without a
   * `break` / without raising". Found by role rather than by field, because it
   * sits among the node's plain children.
   */
  private elseClause(n: FlowNode, exclude: readonly (FlowNode | null)[]): FlowNode | null {
    const skip = new Set(exclude.filter(Boolean).map((c) => c!.id));
    return (
      this.named(n).find(
        (c) => !skip.has(c.id) && this.role(c) === "wrapper" && /else/.test(c.type),
      ) ?? null
    );
  }

  /**
   * The readable head of a construct — everything up to the body it wraps.
   * `for (const x of xs)` rather than the whole loop, which is the difference
   * between a label and a paragraph for the grammars that give a `for…of` or a
   * `using` no condition field to point at.
   */
  private header(n: FlowNode, body: FlowNode | null): string {
    if (!body) return n.text;
    const cut = body.startIndex - n.startIndex;
    return cut > 0 ? n.text.slice(0, cut) : n.text;
  }

  /**
   * Branch nodes and logical operators anywhere under `n` — the same rules
   * `complexity-analyzer.measureBody` counts by, so the two agree on what a
   * branch is.
   */
  private scan(n: FlowNode): number {
    let count = 0;
    const walk = (x: FlowNode): void => {
      if (this.complexity.branchNodes.has(x.type)) count++;
      if (x.type === "binary_expression" || x.type === "boolean_operator") {
        const op = x.childForFieldName("operator");
        if (op && this.complexity.logicalOps.has(op.text)) count++;
      }
      for (const c of x.children) walk(c);
    };
    walk(n);
    return count;
  }

  /**
   * Branches hidden inside `n`'s own expressions: everything the scan finds,
   * less what the structurally-emitted children account for, less `n` itself
   * when it is a branch node (the CFG node carries its `nodeType`, so the
   * cross-check counts it there).
   */
  private inline(n: FlowNode, structural: readonly (FlowNode | null)[]): number {
    let count = this.scan(n);
    for (const child of structural) {
      if (child) count -= this.scan(child);
    }
    if (this.complexity.branchNodes.has(n.type)) count -= 1;
    return Math.max(0, count);
  }

  // ── statement emission ─────────────────────────────────────────────────

  /** Emit a run of statements in order, threading the dangling exits through. */
  private sequence(stmts: readonly FlowNode[], incoming: Pending[]): Pending[] {
    let pending = incoming;
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]!;
      if (this.role(stmt) === "ignore") continue;
      pending = this.statement(stmt, pending);
      // Control cannot reach the rest of the block (a `return` mid-sequence).
      // The remaining statements are not drawn — an edge to them would be a
      // path that does not exist — but their branches are still counted, so
      // the graph can still account for the complexity number.
      if (pending.length === 0) {
        this.countUnreachable(stmts.slice(i + 1));
        break;
      }
    }
    return pending;
  }

  /** Tally the branches in statements the graph will not draw. */
  countUnreachable(stmts: readonly FlowNode[]): void {
    for (const stmt of stmts) {
      if (this.role(stmt) === "ignore") continue;
      this.unreachableBranches += this.scan(stmt);
    }
  }

  statement(n: FlowNode, incoming: Pending[]): Pending[] {
    const label = this.pendingLabel;
    this.pendingLabel = undefined;

    switch (this.role(n)) {
      case "block":
        return this.sequence(this.named(n), incoming);
      case "branch":
        return this.branch(n, incoming);
      case "loop":
        return this.loop(n, incoming, label);
      case "post-test-loop":
        return this.postTestLoop(n, incoming, label);
      case "switch":
        return this.switchStatement(n, incoming, label);
      case "try":
        return this.tryStatement(n, incoming);
      case "return":
        return this.jumpOut(n, incoming, "RETURN", this.exitId, undefined);
      case "throw":
        return this.throwStatement(n, incoming);
      case "break":
        return this.breakStatement(n, incoming);
      case "continue":
        return this.continueStatement(n, incoming);
      case "label":
        return this.labelled(n, incoming);
      case "wrapper":
        return this.wrapper(n, incoming);
      case "catch":
      case "finally":
      case "case":
      case "case-label":
        // Only reachable if a grammar nests one outside its owner; emitting it
        // as a plain statement keeps the sequence intact rather than dropping
        // the subtree.
        return this.plain(n, incoming);
      case "jump":
        return this.jump(n, incoming);
      case "ignore":
        return incoming;
      case "nested-function":
      case undefined:
        return this.plain(n, incoming);
    }
  }

  /**
   * A jump whose kind is in its keyword, not its node type. Kotlin writes
   * `return`, `break`, `continue` and `throw` all as `jump_expression`, so the
   * leading token is the only thing that distinguishes them.
   */
  private jump(n: FlowNode, incoming: Pending[]): Pending[] {
    const keyword = n.children[0]?.type ?? "";
    switch (this.spec.jumpRoles?.[keyword]) {
      case "return":
        return this.jumpOut(n, incoming, "RETURN", this.exitId, undefined);
      case "throw":
        return this.throwStatement(n, incoming);
      case "break":
        return this.breakStatement(n, incoming);
      case "continue":
        return this.continueStatement(n, incoming);
      default:
        return this.plain(n, incoming);
    }
  }

  private plain(n: FlowNode, incoming: Pending[]): Pending[] {
    // A statement the spec has no role for is ordinary straight-line code, and
    // drawing it as one loses nothing. It is a gap only when the complexity
    // table says the node branches: then the number counts structure the graph
    // does not show, and the reader deserves to be told.
    if (this.role(n) === undefined && this.complexity.branchNodes.has(n.type)) {
      this.unmodelled.add(n.type);
    }
    const id = this.node("STATEMENT", n.text, n, this.inline(n, []));
    this.connect(incoming, id);
    return [{ id }];
  }

  private branch(n: FlowNode, incoming: Pending[]): Pending[] {
    return this.branchOn(n, incoming, this.fieldAll(n, "alternative"), 0);
  }

  /**
   * One `if`, with its remaining `else` arms.
   *
   * `alternatives` is the whole chain hanging off the original `if`: one entry
   * for C-family grammars (an `else` clause, which may itself hold the next
   * `if`), but one per `elif` plus the final `else` for Python and PHP, which
   * flatten the chain onto the first node. `index` is how far down that chain
   * this call is, so an `elif` takes the false edge and passes the rest on.
   */
  private branchOn(
    n: FlowNode,
    incoming: Pending[],
    alternatives: readonly FlowNode[],
    index: number,
  ): Pending[] {
    const condition = this.field(n, "condition");
    const consequence = this.field(n, "consequence");
    const rest = alternatives.slice(index);

    const id = this.node(
      "DECISION",
      condition ? condition.text : n.text,
      n,
      this.inline(n, [consequence, ...rest]),
    );
    this.connect(incoming, id);

    const thenExits = consequence
      ? this.statement(consequence, [{ id, label: "true" }])
      : [{ id, label: "true" }];
    const elseExits = this.alternativeAt(alternatives, index, [{ id, label: "false" }]);

    // Only draw a rejoin where control really rejoins. An `if` whose branches
    // both return has no merge, and inventing one would draw a path out of a
    // function that has already left.
    if (thenExits.length > 0 && elseExits.length > 0) {
      const merge = this.add("MERGE", "", undefined, n.endPosition.row + 1, n.endPosition.row + 1, 0);
      this.connect([...thenExits, ...elseExits], merge);
      return [{ id: merge }];
    }
    return [...thenExits, ...elseExits];
  }

  /** Emit alternative `index` of a chain, or fall through when there is none. */
  private alternativeAt(
    alternatives: readonly FlowNode[],
    index: number,
    incoming: Pending[],
  ): Pending[] {
    const alt = alternatives[index];
    if (!alt) return incoming;
    if (this.role(alt) !== "branch") return this.statement(alt, incoming);

    // Two ways a grammar writes `else if`. Nested (TypeScript, Java, Kotlin):
    // the alternative is a whole `if` carrying its own `else`, so it owns the
    // rest of the chain. Flattened (Python, PHP): the `elif` has a condition
    // and a body and nothing else, and the remaining arms are still siblings
    // on the original `if`. Reading the alternative's own list is what tells
    // them apart — and getting it wrong silently drops the final `else`.
    const own = this.fieldAll(alt, "alternative");
    return own.length > 0
      ? this.branchOn(alt, incoming, own, 0)
      : this.branchOn(alt, incoming, alternatives, index + 1);
  }

  private loop(n: FlowNode, incoming: Pending[], label: string | undefined): Pending[] {
    const body = this.field(n, "body");
    const condition = this.field(n, "condition");
    // Python's `for … else` hangs the else off the loop, and it is emitted
    // structurally below — so it has to come out of the loop's own hidden
    // count here, or every branch inside it is charged twice.
    const otherwise = this.elseClause(n, [body, condition]);
    const head = this.node(
      "LOOP",
      condition ? condition.text : this.header(n, body),
      n,
      this.inline(n, [body, otherwise]),
    );
    this.connect(incoming, head);

    const frame: JumpFrame = { kind: "loop", label, continueTarget: head, breaks: [] };
    this.jumps.push(frame);
    const bodyExits = body ? this.statement(body, [{ id: head, label: "true" }]) : [];
    this.jumps.pop();

    for (const exit of bodyExits) this.edge(exit.id, head, exit.label, true);

    // `for … else` / `while … else`: the `else` runs when the loop ran out
    // rather than being broken out of, so it belongs on the false edge and the
    // collected `break`s step around it.
    const completed: Pending[] = [{ id: head, label: "false" }];
    const afterElse = otherwise ? this.statement(otherwise, completed) : completed;
    return [...afterElse, ...frame.breaks];
  }

  private postTestLoop(n: FlowNode, incoming: Pending[], label: string | undefined): Pending[] {
    const body = this.field(n, "body");
    const condition = this.field(n, "condition");

    // The body runs before the test, so the loop head is a rejoin point and
    // the test sits at the bottom — which is also where `continue` lands.
    const head = this.add("MERGE", "do", n.type, n.startPosition.row + 1, n.startPosition.row + 1, 0);
    this.connect(incoming, head);

    const test = this.node("LOOP", condition ? condition.text : n.text, n, this.inline(n, [body]));
    const frame: JumpFrame = { kind: "loop", label, continueTarget: test, breaks: [] };
    this.jumps.push(frame);
    const bodyExits = body ? this.statement(body, [{ id: head }]) : [{ id: head }];
    this.jumps.pop();

    this.connect(bodyExits, test);
    this.edge(test, head, "true", true);
    return [{ id: test, label: "false" }, ...frame.breaks];
  }

  private switchStatement(n: FlowNode, incoming: Pending[], label: string | undefined): Pending[] {
    const body = this.field(n, "body") ?? n;
    const discriminant = this.field(n, "value");
    const arms = this.named(body).filter((c) => this.role(c) === "case");

    // What the arms account for is subtracted from the switch's own hidden
    // count. Grammars that wrap the arms in a body node (C#, Java, PHP) hand
    // that over in one piece; Kotlin hangs them straight off the `when`, and
    // subtracting only a body that is not there would charge the switch for
    // every branch in every arm.
    const accounted = body === n ? arms : [body];
    const id = this.node(
      "DECISION",
      discriminant ? discriminant.text : this.header(n, body === n ? null : body),
      n,
      this.inline(n, accounted),
    );
    this.connect(incoming, id);

    const frame: JumpFrame = { kind: "switch", label, breaks: [] };
    this.jumps.push(frame);

    const falls = this.spec.fallthrough !== false;
    const wildcards = new Set(this.spec.wildcardLabels ?? DEFAULT_WILDCARD_LABELS);
    let fallthrough: Pending[] = [];
    /** Arm exits that leave the switch directly, for a grammar without fallthrough. */
    const completed: Pending[] = [];
    let sawDefault = false;

    for (const arm of arms) {
      const labels = this.named(arm).filter((c) => this.role(c) === "case-label");
      const valueField = this.field(arm, "value");
      const labelNodes = labels.length > 0 ? labels : valueField ? [valueField] : [];
      // No label of any kind is how both dialects spell `default:` — an arm
      // with only statements under it.
      const isDefault = labelNodes.length === 0;
      if (isDefault) sawDefault = true;

      const text = isDefault
        ? "default"
        : labelNodes.map((l) => collapse(l.text)).join(", ");
      // A catch-all spelled as a label (`default:`, `case _:`, `else ->`) is
      // still a default, and marking it stops the switch gaining an edge for
      // a value that cannot go unmatched.
      if (!isDefault && wildcards.has(text.replace(/[:\s]+$/, ""))) sawDefault = true;
      const armEntry: Pending[] = [{ id, label: text }, ...fallthrough];

      const statements = this.named(arm).filter(
        (c) => this.role(c) !== "case-label" && c.id !== valueField?.id,
      );
      const inline = this.inline(arm, statements);
      const armNode = this.node("DECISION", text, arm, inline);
      this.connect(armEntry, armNode);
      const armExits = this.sequence(statements, [{ id: armNode }]);

      // C-family arms run on into the next one unless something jumps out.
      // Python's `match` and Kotlin's `when` do not, so their arms' exits
      // leave the construct instead of feeding the arm below.
      if (falls) {
        fallthrough = armExits;
      } else {
        completed.push(...armExits);
      }
    }

    this.jumps.pop();

    // A grammar with no body node can hang the `else` arm's statements
    // straight off the switch, unwrapped (Pascal's `case … else`). Whatever is
    // left after the value and the arms is that branch; without this it is a
    // subtree the graph silently drops.
    if (body === n) {
      const accountedFor = new Set([
        ...arms.map((a) => a.id),
        ...(discriminant ? [discriminant.id] : []),
      ]);
      const leftover = this.named(n).filter(
        (c) => !accountedFor.has(c.id) && this.role(c) !== "case-label" && this.role(c) !== "ignore",
      );
      if (leftover.length > 0) {
        sawDefault = true;
        const armNode = this.node("DECISION", "else", n, 0);
        this.connect([{ id, label: "else" }], armNode);
        completed.push(...this.sequence(leftover, [{ id: armNode }]));
      }
    }

    const exits = [...frame.breaks, ...fallthrough, ...completed];
    // With no `default`, the unmatched value flows straight past the switch.
    if (!sawDefault) exits.push({ id, label: "default" });
    return exits;
  }

  private tryStatement(n: FlowNode, incoming: Pending[]): Pending[] {
    const body = this.field(n, "body");
    // Found by role rather than by field: TypeScript names the handler and the
    // finalizer, C# hangs both off the try as plain named children.
    const catches = this.named(n).filter((c) => this.role(c) === "catch");
    // Grammars that give the `finally` a node of its own are found by role;
    // Pascal marks it with a field on the `try` and hangs a bare statement
    // list off it, so the field is the fallback. Its keyword token carries the
    // same field name, hence the filter down to something that holds code.
    const finalizer =
      this.named(n).find((c) => this.role(c) === "finally") ??
      this.fieldAll(n, "finalizer").find((c) => this.role(c) === "block");
    if (finalizer) this.hasFinally = true;

    const catchHeads = catches.map((c) => {
      const decl = this.named(c).find((x) => this.role(x) === undefined && x.type !== "block");
      return this.node("CATCH", decl ? `catch ${decl.text}` : "catch", c, 0);
    });

    const guard: Guard = {};
    if (catchHeads.length > 0) guard.handler = catchHeads[0];
    if (finalizer) guard.unwinds = [];
    this.guards.push(guard);

    const { entry: bodyEntry, result: bodyExits } = this.entryOf(() =>
      body ? this.statement(body, incoming) : incoming,
    );
    // Past the guarded block: the clauses below are no longer protected by
    // themselves, but a jump out of one still runs the `finally`.
    guard.handler = undefined;

    // One edge per handler from the head of the guarded region: any statement
    // in there can raise, and an edge from each of them would bury the graph.
    if (bodyEntry) {
      for (const head of catchHeads) this.edge(bodyEntry, head, "throws");
    }

    const catchExits: Pending[] = [];
    catches.forEach((clause, i) => {
      const clauseBody = this.field(clause, "body") ?? this.named(clause).at(-1);
      const head = catchHeads[i]!;
      if (clauseBody && this.role(clauseBody) === "block") {
        catchExits.push(...this.statement(clauseBody, [{ id: head }]));
      } else {
        catchExits.push({ id: head });
      }
    });

    this.guards.pop();

    // Python's `try … else`: runs only when the guarded block completed
    // without raising, so it sits on the body's exits and not the catches'.
    const otherwise = this.elseClause(n, [body, finalizer ?? null, ...catches]);
    const succeeded = otherwise ? this.statement(otherwise, bodyExits) : bodyExits;

    const normalExits = [...succeeded, ...catchExits];
    if (!finalizer) return normalExits;
    const unwinds = guard.unwinds ?? [];

    const finallyBody =
      this.role(finalizer) === "block"
        ? finalizer
        : (this.field(finalizer, "body") ?? this.named(finalizer).at(-1));
    if (!finallyBody) return normalExits;

    const { entry: finallyEntry, result: finallyExits } = this.entryOf(() =>
      this.statement(finallyBody, normalExits),
    );
    // Wired after the fact: the `finally`'s own nodes have to exist first, and
    // a `try` whose every path returns reaches this with no normal exit at all
    // — which is exactly the shape that would otherwise leave the whole
    // `finally` block floating, drawn but connected to nothing.
    if (finallyEntry) {
      for (const jump of unwinds) {
        this.edges.push({ from: jump.id, to: finallyEntry, label: jump.label, unwind: true });
      }
    }
    return finallyExits;
  }

  private jumpOut(
    n: FlowNode,
    incoming: Pending[],
    kind: CfgNodeKind,
    target: string,
    edgeLabel: string | undefined,
  ): Pending[] {
    const id = this.node(kind, n.text, n, this.inline(n, []));
    this.connect(incoming, id);
    this.edge(id, target, edgeLabel);
    this.recordUnwind(id);
    return [];
  }

  /**
   * Note that this jump leaves a guarded region, so the `finally` can be
   * reached from it. Only the innermost region is recorded: a jump through two
   * nested `finally` blocks runs both, and drawing the second detour would
   * cross the first without saying so.
   */
  private recordUnwind(id: string): void {
    for (let i = this.guards.length - 1; i >= 0; i--) {
      const unwinds = this.guards[i]!.unwinds;
      if (unwinds) {
        unwinds.push({ id, label: "finally" });
        return;
      }
    }
  }

  private throwStatement(n: FlowNode, incoming: Pending[]): Pending[] {
    let handler: string | undefined;
    for (let i = this.guards.length - 1; i >= 0 && handler === undefined; i--) {
      handler = this.guards[i]!.handler;
    }
    const id = this.node("THROW", n.text, n, this.inline(n, []));
    this.connect(incoming, id);
    this.edge(id, handler ?? this.exitId, "throws");
    // A caught `throw` does not leave the region: it runs the `catch`, and the
    // path from there through the `finally` is already drawn. Only an uncaught
    // one needs the detour.
    if (handler === undefined) this.recordUnwind(id);
    return [];
  }

  /** The frame a `break`/`continue` targets: the labelled one, else the innermost. */
  private frameFor(label: string | undefined, needsContinue: boolean): JumpFrame | undefined {
    for (let i = this.jumps.length - 1; i >= 0; i--) {
      const frame = this.jumps[i]!;
      if (needsContinue && frame.continueTarget === undefined) continue;
      if (label === undefined || frame.label === label) return frame;
    }
    return undefined;
  }

  /** The label on `break outer;` — the one named child, when the grammar has one. */
  private jumpLabel(n: FlowNode): string | undefined {
    const target = this.named(n)[0];
    return target ? target.text : undefined;
  }

  private breakStatement(n: FlowNode, incoming: Pending[]): Pending[] {
    const id = this.node("BREAK_CONTINUE", n.text, n, this.inline(n, []));
    this.connect(incoming, id);
    const frame = this.frameFor(this.jumpLabel(n), false);
    // A `break` with no enclosing loop or switch cannot be sequenced; sending
    // it to the exit keeps the graph connected and is what the runtime does
    // with the equivalent (a labelled block break) anyway.
    if (frame) frame.breaks.push({ id, label: "break" });
    else this.edge(id, this.exitId, "break");
    this.recordUnwind(id);
    return [];
  }

  private continueStatement(n: FlowNode, incoming: Pending[]): Pending[] {
    const id = this.node("BREAK_CONTINUE", n.text, n, this.inline(n, []));
    this.connect(incoming, id);
    const frame = this.frameFor(this.jumpLabel(n), true);
    if (frame?.continueTarget) this.edge(id, frame.continueTarget, "continue", true);
    else this.edge(id, this.exitId, "continue");
    this.recordUnwind(id);
    return [];
  }

  private labelled(n: FlowNode, incoming: Pending[]): Pending[] {
    const labelNode = this.field(n, "label") ?? this.named(n)[0];
    const body = this.field(n, "body") ?? this.named(n).at(-1);
    if (!body) return this.plain(n, incoming);
    this.pendingLabel = labelNode ? labelNode.text : undefined;
    return this.statement(body, incoming);
  }

  private wrapper(n: FlowNode, incoming: Pending[]): Pending[] {
    const body = this.field(n, "body") ?? this.named(n).at(-1);
    if (!body) return this.plain(n, incoming);

    // A wrapper draws nothing of its own, so anything branching in its header
    // (`using (x ?? y)`) would be lost — give it a node when it has some.
    //
    // It also gets one when the complexity table counts the wrapper itself as
    // a branch, as Python's does for `with`: the graph has to show every
    // branch the number charges for, or it cannot explain the number.
    const hidden = this.inline(n, [body]);
    const counted = this.complexity.branchNodes.has(n.type);
    let pending = incoming;
    if (hidden > 0 || counted) {
      const id = this.node("STATEMENT", this.header(n, body), n, hidden);
      this.connect(incoming, id);
      pending = [{ id }];
    }
    return this.statement(body, pending);
  }

  finish(pending: Pending[]): void {
    this.connect(pending, this.exitId);
  }
}

/**
 * Resolve the node whose statements make up the function body.
 *
 * `findBodyNode` returns the largest node inside the function's line range,
 * which for an ordinary function is the declaration itself — and sometimes the
 * `program` or a class body, when the function fills it. Descending to the
 * declaration that starts on the function's own line mirrors the `declRow`
 * test `measureBody` uses for the same reason.
 */
function resolveBody(
  node: FlowNode,
  declRow: number,
  spec: LanguageControlFlowSpec,
  fields: Record<ControlFlowField, readonly string[]>,
): FlowNode | null {
  // Strictly the declared body, with no blind "last child" fallback: an
  // interface signature or an abstract method has no body, and falling back
  // would hand back its return type and draw a one-box graph of a declaration.
  //
  // A language that names no fields declares the position instead (`shapes`),
  // and that answer is checked before it is used: a bodiless declaration's
  // last child is its return type, which holds no statements, so requiring the
  // candidate to actually be a block keeps the same refusal.
  const bodyOf = (n: FlowNode): FlowNode | null => {
    for (const name of fields.body) {
      const hit = n.childForFieldName(name);
      if (hit) return hit;
    }
    const at = spec.shapes?.[n.type]?.body;
    if (at === undefined) return null;
    const named = n.children.filter((c) => c.isNamed);
    const candidate = (at < 0 ? named[named.length + at] : named[at]) ?? null;
    if (!candidate) return null;
    const role = spec.roles.get(candidate.type);
    return role === "block" || role === "wrapper" ? candidate : null;
  };

  if (spec.roles.get(node.type) === "nested-function") return bodyOf(node);

  // The declaration may sit a level or two down (inside `program`, a class
  // body, an export or a variable declarator). Search breadth-first and stop
  // at the first declaration that opens on the function's own line.
  let frontier = [node];
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const next: FlowNode[] = [];
    for (const n of frontier) {
      for (const child of n.children) {
        if (!child.isNamed) continue;
        if (
          spec.roles.get(child.type) === "nested-function" &&
          child.startPosition.row === declRow
        ) {
          return bodyOf(child);
        }
        next.push(child);
      }
    }
    frontier = next;
  }
  return node;
}

/**
 * Build the CFG for one function of an already-parsed file. Returns `null`
 * when the language declares no control-flow spec, or when the function's body
 * cannot be located — a graph of the wrong node would be worse than none.
 */
export function buildControlFlow(
  tree: TSTree,
  language: Language,
  fn: FunctionRef,
  filePath: string,
): Cfg | null {
  if (pluginFor(language)?.parsing === "custom") return null;
  const spec = controlFlowFor(language);
  if (!spec) return null;

  const fields = { ...DEFAULT_CONTROL_FLOW_FIELDS, ...(spec.fields ?? {}) } as Record<
    ControlFlowField,
    readonly string[]
  >;
  const complexity = complexityFor(language) ?? DEFAULT_COMPLEXITY;

  const located = findBodyNode(tree.rootNode, fn.line, fn.endLine, makeEndRowMemo());
  if (!located) return null;
  const body = resolveBody(located, fn.line - 1, spec, fields);
  if (!body) return null;

  return buildFromBody(body, { spec, complexity, fields, language, fn, filePath });
}

/** Everything the interpreter needs that is not the body itself. */
export interface BuildContext {
  spec: LanguageControlFlowSpec;
  complexity: LanguageComplexitySpec;
  fields: Record<ControlFlowField, readonly string[]>;
  language: Language;
  fn: FunctionRef;
  filePath: string;
  /** Marks a graph read off the text rather than a parse tree. */
  approximate?: boolean;
}

/**
 * Run the interpreter over an already-resolved function body.
 *
 * Split out from `buildControlFlow` so the regex tier can reach it: that tier
 * has no tree to search, because it synthesizes the body directly. Everything
 * after this point is identical for both, which is the point — one
 * interpreter, so a fix to either tier is a fix to both.
 */
export function buildFromBody(body: FlowNode, ctx: BuildContext): Cfg {
  const { spec, complexity, fields, language, fn, filePath } = ctx;
  const builder = new Builder(spec, complexity, fields, fn.name, fn.line, fn.endLine);
  const statements =
    spec.roles.get(body.type) === "block"
      ? body.children.filter((c) => c.isNamed)
      : [body];
  let pending: Pending[] = [{ id: builder.entryId }];
  for (let i = 0; i < statements.length; i++) {
    pending = builder.statement(statements[i]!, pending);
    if (pending.length === 0) {
      builder.countUnreachable(statements.slice(i + 1));
      break;
    }
  }
  builder.finish(pending);

  const cfg: Cfg = {
    functionName: fn.name,
    filePath,
    language,
    line: fn.line,
    endLine: fn.endLine,
    entry: builder.entryId,
    exit: builder.exitId,
    nodes: builder.nodes,
    edges: builder.edges,
    unmodelled: [...builder.unmodelled].sort(),
    hasFinally: builder.hasFinally,
    unreachableBranches: builder.unreachableBranches,
  };
  if (ctx.approximate) cfg.approximate = true;
  return cfg;
}

/**
 * Cyclomatic complexity read off the graph — decision nodes plus the branches
 * hidden in their expressions, by the same tables `computeComplexity` counts
 * with.
 *
 * This is the cross-check that keeps the two honest: the metric counts branch
 * nodes in a body, this counts what the graph modelled, and
 * `control-flow.test.ts` asserts they agree for every function in the
 * fixtures. A dropped subtree shows up here as a number that no longer
 * matches.
 */
export function cyclomaticFromCfg(cfg: Cfg, language: Language): number {
  const branchNodes = (complexityFor(language) ?? DEFAULT_COMPLEXITY).branchNodes;
  let count = 1 + cfg.unreachableBranches;
  for (const node of cfg.nodes) {
    if (node.nodeType !== undefined && branchNodes.has(node.nodeType)) count++;
    count += node.inlineBranches;
  }
  return count;
}

/** Roles the builder is expected to give a node of its own in the graph. */
const STRUCTURAL: ReadonlySet<ControlFlowRole> = new Set<ControlFlowRole>([
  "branch",
  "loop",
  "post-test-loop",
  "switch",
  "case",
  // `try` itself is deliberately absent: the builder draws the guarded
  // statements and the `catch` heads, not a box for the keyword.
  "catch",
  "return",
  "throw",
  "break",
  "continue",
]);

/**
 * Control-flow constructs in the body that the graph never drew.
 *
 * The arithmetic cross-check (`cyclomaticFromCfg` against `computeComplexity`)
 * is the sharper gate where it applies, but it can only see what the
 * complexity table counts — and a table can be wrong. Pascal's names five node
 * types its grammar does not have, so every Delphi function reports complexity
 * 1 and the arithmetic agrees with the graph no matter what the graph does.
 *
 * This looks instead at the source: walk the same body, and for every node the
 * language gave a structural role, require a graph node of that type on that
 * line. It needs no table to be right, so it holds for a language whose table
 * is broken, and it names what went missing rather than a number that differs.
 */
export function undrawnStructure(
  tree: TSTree,
  language: Language,
  fn: FunctionRef,
  cfg: Cfg,
): { type: string; line: number }[] {
  const spec = controlFlowFor(language);
  if (!spec) return [];
  const fields = { ...DEFAULT_CONTROL_FLOW_FIELDS, ...(spec.fields ?? {}) } as Record<
    ControlFlowField,
    readonly string[]
  >;
  const located = findBodyNode(tree.rootNode, fn.line, fn.endLine, makeEndRowMemo());
  if (!located) return [];
  const body = resolveBody(located, fn.line - 1, spec, fields);
  if (!body) return [];

  const drawn = new Set(cfg.nodes.map((n) => `${n.nodeType}@${n.line}`));
  // Anything under a node drawn as a plain statement is in expression
  // position — a Kotlin `val x = if (a) 1 else 2`, a PHP `?? throw` — and the
  // builder reports it in that node's `inlineBranches` rather than drawing it.
  // That is accounted for, not missing.
  const inlined = new Set(
    cfg.nodes.filter((n) => n.kind === "STATEMENT").map((n) => `${n.nodeType}@${n.line}`),
  );
  const missing: { type: string; line: number }[] = [];

  const roleOf = (type: string): ControlFlowRole | undefined =>
    spec.roles.get(type) ?? (spec.ignorePattern?.test(type) === true ? "ignore" : undefined);

  const walk = (n: FlowNode): void => {
    const role = roleOf(n.type);
    // The graph deliberately stops at a nested function, so what is inside one
    // is not missing — it is out of scope, and counted as hidden instead.
    if (role === "nested-function") return;
    const key = `${n.type}@${n.startPosition.row + 1}`;
    if (inlined.has(key)) return;
    if (role !== undefined && STRUCTURAL.has(role) && !drawn.has(key)) {
      missing.push({ type: n.type, line: n.startPosition.row + 1 });
    }
    for (const child of n.children) walk(child);
  };
  // A curried `(a) => (b) => { … }`: the body IS the nested function, drawn as one statement.
  if (roleOf(body.type) === "nested-function") return missing;
  for (const child of body.children) walk(child);
  return missing;
}
