/**
 * Control-flow IR for a single function body.
 *
 * Built on demand (never written into `project-summary.json`) — a CFG is
 * per-function detail, and carrying one for every function of every file would
 * multiply the artifact for something almost nobody reads in aggregate.
 * `src/core/control-flow.ts` builds it, `control-flow-mermaid.ts` renders it.
 *
 * The node kinds are deliberately few. A visual CFG earns its keep by making
 * the *shape* of a function legible; a kind that no renderer distinguishes and
 * no test pins is a kind that only adds ways to be wrong. Add one when a
 * language forces it.
 */

export type CfgNodeKind =
  /** Single entry point — the function declaration. */
  | "ENTRY"
  /** Single normal exit — every path that leaves the function converges here. */
  | "EXIT"
  /** A straight-line statement: no branching of its own. */
  | "STATEMENT"
  /** A condition with two or more outgoing edges (`if`, loop test, case label). */
  | "DECISION"
  /** Where branches rejoin. Kept explicit so a diagram can show the rejoin. */
  | "MERGE"
  /** The head of a loop — carries the back edge. */
  | "LOOP"
  /** `break` / `continue`: control leaves the statement sequence sideways. */
  | "BREAK_CONTINUE"
  /** `return`: control leaves the function. */
  | "RETURN"
  /** `throw`: control leaves normally-flowing code. */
  | "THROW"
  /** A `catch` clause head. */
  | "CATCH";

export interface CfgNode {
  /** Unique within its `Cfg`; also the Mermaid node id seed. */
  id: string;
  kind: CfgNodeKind;
  /** Human-readable source text for the node, already trimmed and collapsed. */
  label: string;
  /**
   * The tree-sitter node type this came from, or `undefined` for the
   * synthetic ENTRY/EXIT/MERGE nodes. Keeping it lets the tests cross-check
   * the graph against the complexity tables without the builder hard-coding
   * which kinds count as a branch.
   */
  nodeType?: string;
  /** 1-based source line, for diagram → editor navigation. */
  line: number;
  /** 1-based last source line of the construct. */
  endLine: number;
  /**
   * Branches hidden *inside* this node's own expressions — ternaries, `&&`/`||`
   * short circuits, and any branch inside a callback the graph does not
   * descend into. Rendered as a badge: a plain-looking statement that hides
   * four decisions is exactly the thing a reader needs pointed out.
   */
  inlineBranches: number;
}

export interface CfgEdge {
  from: string;
  to: string;
  /** Edge label (`true`, `false`, `break`, `case 3`, …); absent for plain flow. */
  label?: string;
  /** A loop's back edge, drawn dotted so the cycle reads at a glance. */
  back?: boolean;
  /**
   * A `finally` reached on the way out: a `return`/`throw`/`break` inside a
   * guarded block runs the `finally` before it leaves. The jump keeps its own
   * edge to where it is really going, and this one records the detour.
   */
  unwind?: boolean;
}

export interface Cfg {
  /** As reported by the complexity analyzer — `Class.method` for methods. */
  functionName: string;
  /** Project-relative when the caller passes one; otherwise as given. */
  filePath: string;
  language: string;
  /** 1-based declaration line / last line of the function. */
  line: number;
  endLine: number;
  entry: string;
  exit: string;
  nodes: CfgNode[];
  edges: CfgEdge[];
  /**
   * Node types encountered that the language's spec gives no role. They are
   * emitted as plain `STATEMENT`s, which is honest but lossy, so the renderer
   * can say so. A dropped edge is a lie a reader cannot see; an unmodelled
   * node is one they can.
   */
  unmodelled: string[];
  /**
   * True when the body contains a `finally` — a reminder that abnormal exits
   * (`return`/`throw` from inside the `try`) also run it, which this IR does
   * not draw. See `control-flow.ts`.
   */
  hasFinally: boolean;
  /**
   * Branches in code the graph did not draw because nothing reaches it — a
   * statement after a `return`, or a hoisted declaration below one.
   *
   * Unreachable code is still counted by the complexity metric, so without
   * this the graph could not account for the number it exists to explain. It
   * is reported rather than drawn: connecting it would invent a path, and
   * leaving it out silently would lose it.
   */
  unreachableBranches: number;
  /**
   * True when the graph was read off the source text rather than a parse tree.
   *
   * The ~29 regex-extracted languages have no parser, so their graphs come
   * from a line scanner that infers nesting from block delimiters. It gets the
   * shape of ordinary code right and has no way to be sure: a keyword inside a
   * construct it does not know, a brace inside something the comment stripper
   * missed, and the nesting is off. Anything showing one of these has to say
   * so — the reader can discount an approximation, but not one presented as a
   * parse.
   */
  approximate?: boolean;
}

/**
 * The slice of a syntax node the control-flow builder actually reads.
 *
 * It exists so there is exactly ONE interpreter. Most languages arrive as a
 * tree-sitter tree, but the ~29 regex-extracted ones have no parser at all;
 * rather than write a second builder for them — which would drift from the
 * first the moment either was fixed — the regex tier synthesizes nodes of this
 * shape from the source text, gives them the same canonical types the shared
 * role table already names, and hands them to the same code.
 *
 * `web-tree-sitter`'s `Node` satisfies this structurally, so nothing had to
 * change on the tree-sitter side to make room for it.
 */
export interface FlowNode {
  /** Unique within its tree; used only to tell two nodes apart. */
  readonly id: number;
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly startIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly children: readonly FlowNode[];
  readonly childCount: number;
  child(index: number): FlowNode | null;
  childForFieldName(fieldName: string): FlowNode | null;
  fieldNameForChild(index: number): string | null;
}
