import type { Tree } from "web-tree-sitter";

/**
 * A syntax tree read once into plain typed arrays (feature `flat-tree`).
 *
 * Every property read of a web-tree-sitter `Node` crosses into WebAssembly and mints a wrapper object. Here one
 * `TreeCursor` walk copies the tree into arrays indexed by the node's preorder position; `FlatNode` is a class of our
 * own over them (an index and the tree), answering the subset of `Node` the extractors use from those arrays. Child
 * lists are built on first use into the TREE's tables, never onto a node: a node has two fixed fields, so every access
 * stays monomorphic (the hidden-class trap the `type` cache patch in parser-manager.ts documents).
 *
 * The answers equal the real node's; `flat-tree.test.ts` walks fixture trees of every tree-sitter language and
 * compares each used member.
 */

const NAMED = 1;
const MISSING = 2;
const ERROR_TYPE = 4;
const HAS_ERROR = 8;

/** Ids given to nodes of every flat tree, so two trees never share one (a real `id` is an address). */
let nextIdBase = 1;

export interface Point {
  row: number;
  column: number;
}

/** A node of a `FlatTree`: the subset of web-tree-sitter's `Node` that extractors read, answered from arrays. */
export class FlatNode {
  constructor(
    readonly tree: FlatTree,
    readonly index: number,
  ) {}

  get id(): number {
    return this.tree.idBase + this.index;
  }
  get type(): string {
    return this.tree.typeNames[this.tree.typeIds[this.index]!]!;
  }
  get typeId(): number {
    return this.tree.typeIds[this.index]!;
  }
  get isNamed(): boolean {
    return (this.tree.flags[this.index]! & NAMED) !== 0;
  }
  get isMissing(): boolean {
    return (this.tree.flags[this.index]! & MISSING) !== 0;
  }
  get isError(): boolean {
    return (this.tree.flags[this.index]! & ERROR_TYPE) !== 0;
  }
  get hasError(): boolean {
    return (this.tree.flags[this.index]! & HAS_ERROR) !== 0;
  }
  get startIndex(): number {
    return this.tree.starts[this.index]!;
  }
  get endIndex(): number {
    return this.tree.ends[this.index]!;
  }
  get startPosition(): Point {
    return this.tree.pointAt(this.tree.starts[this.index]!);
  }
  get endPosition(): Point {
    return this.tree.pointAt(this.tree.ends[this.index]!);
  }
  get text(): string {
    return this.tree.source.slice(this.tree.starts[this.index]!, this.tree.ends[this.index]!);
  }
  get parent(): FlatNode | null {
    const p = this.tree.parents[this.index]!;
    return p < 0 ? null : this.tree.node(p);
  }
  get children(): FlatNode[] {
    return this.tree.childrenOf(this.index);
  }
  get namedChildren(): FlatNode[] {
    return this.tree.namedChildrenOf(this.index);
  }
  get childCount(): number {
    return this.tree.childCountOf(this.index);
  }
  get namedChildCount(): number {
    return this.tree.namedChildrenOf(this.index).length;
  }
  child(i: number): FlatNode | null {
    return this.tree.childrenOf(this.index)[i] ?? null;
  }
  namedChild(i: number): FlatNode | null {
    return this.tree.namedChildrenOf(this.index)[i] ?? null;
  }
  get firstChild(): FlatNode | null {
    const c = this.tree.firstChilds[this.index]!;
    return c < 0 ? null : this.tree.node(c);
  }
  get firstNamedChild(): FlatNode | null {
    return this.tree.namedChildrenOf(this.index)[0] ?? null;
  }
  get lastChild(): FlatNode | null {
    const kids = this.tree.childrenOf(this.index);
    return kids[kids.length - 1] ?? null;
  }
  get lastNamedChild(): FlatNode | null {
    const kids = this.tree.namedChildrenOf(this.index);
    return kids[kids.length - 1] ?? null;
  }
  get nextSibling(): FlatNode | null {
    const s = this.nextRelevant(false);
    return s < 0 ? null : this.tree.node(s);
  }
  get previousSibling(): FlatNode | null {
    const s = this.tree.prevSiblings[this.index]!;
    return s < 0 ? null : this.tree.node(s);
  }
  get nextNamedSibling(): FlatNode | null {
    const s = this.nextRelevant(true);
    return s < 0 ? null : this.tree.node(s);
  }
  /**
   * The next sibling as web-tree-sitter answers it: one that is empty and sits where this node ends (a MISSING token
   * a parse error inserted) is passed over, though `children` lists it.
   */
  private nextRelevant(namedOnly: boolean): number {
    const t = this.tree;
    const end = t.ends[this.index]!;
    for (let s = t.nextSiblings[this.index]!; s >= 0; s = t.nextSiblings[s]!) {
      if (t.starts[s] === end && t.ends[s] === end) continue;
      if (!namedOnly || (t.flags[s]! & NAMED) !== 0) return s;
    }
    return -1;
  }
  get previousNamedSibling(): FlatNode | null {
    for (let s = this.tree.prevSiblings[this.index]!; s >= 0; s = this.tree.prevSiblings[s]!) {
      if ((this.tree.flags[s]! & NAMED) !== 0) return this.tree.node(s);
    }
    return null;
  }
  get descendantCount(): number {
    return this.tree.subtreeEnds[this.index]! - this.index;
  }
  /** `childForFieldName` of an ERROR node is null (web-tree-sitter has no field map for it), though `fieldNameForChild` and `childrenForFieldName` answer. */
  childForFieldName(name: string): FlatNode | null {
    const id = this.tree.fieldIdOf(name);
    if (id === 0 || this.isError) return null;
    for (let c = this.tree.firstChilds[this.index]!; c >= 0; c = this.tree.nextSiblings[c]!) {
      if (this.tree.fieldIds[c] === id) return this.tree.node(c);
    }
    return null;
  }
  childrenForFieldName(name: string): FlatNode[] {
    const id = this.tree.fieldIdOf(name);
    const out: FlatNode[] = [];
    if (id === 0) return out;
    for (let c = this.tree.firstChilds[this.index]!; c >= 0; c = this.tree.nextSiblings[c]!) {
      if (this.tree.fieldIds[c] === id) out.push(this.tree.node(c));
    }
    return out;
  }
  fieldNameForChild(i: number): string | null {
    const kid = this.tree.childrenOf(this.index)[i];
    if (!kid) return null;
    const id = this.tree.fieldIds[kid.index]!;
    return id === 0 ? null : this.tree.fieldNames[id]!;
  }
  /** The nodes of this subtree, itself first when its type matches (as web-tree-sitter's), whose type is among `types`, in document order. */
  descendantsOfType(types: string | string[]): FlatNode[] {
    const wanted = this.tree.typeIdsNamed(types);
    const out: FlatNode[] = [];
    if (wanted.size === 0) return out;
    const { typeIds } = this.tree;
    for (let i = this.index, end = this.tree.subtreeEnds[this.index]!; i < end; i++) {
      if (wanted.has(typeIds[i]!)) out.push(this.tree.node(i));
    }
    return out;
  }
  toString(): string {
    return `FlatNode(${this.type})`;
  }
}

/** One tree-sitter tree as arrays, copied by `flattenTree`. Not a drop-in for the whole `Tree` class: `rootNode`, `delete`. */
export class FlatTree {
  readonly idBase: number;
  readonly typeNames: string[] = [];
  readonly fieldNames: string[] = [""];
  private readonly fieldIdByName = new Map<string, number>();
  private readonly typeIdsByName = new Map<string, number[]>();
  private readonly nodes: (FlatNode | undefined)[];
  private readonly kids: (FlatNode[] | undefined)[];
  private readonly namedKids: (FlatNode[] | undefined)[];
  private lineStarts: number[] | null = null;
  private readonly wantedMemo = new Map<string, Set<number>>();

  constructor(
    readonly source: string,
    readonly count: number,
    readonly typeIds: Uint16Array,
    readonly fieldIds: Uint16Array,
    readonly flags: Uint8Array,
    readonly starts: Uint32Array,
    readonly ends: Uint32Array,
    readonly parents: Int32Array,
    readonly firstChilds: Int32Array,
    readonly nextSiblings: Int32Array,
    readonly prevSiblings: Int32Array,
    readonly subtreeEnds: Int32Array,
  ) {
    this.idBase = nextIdBase;
    nextIdBase += count;
    this.nodes = new Array(count);
    this.kids = new Array(count);
    this.namedKids = new Array(count);
  }

  get rootNode(): FlatNode {
    return this.node(0);
  }

  /** Nothing to free: the WebAssembly tree is gone after the copy. */
  delete(): void {}

  node(i: number): FlatNode {
    return (this.nodes[i] ??= new FlatNode(this, i));
  }

  childrenOf(i: number): FlatNode[] {
    let list = this.kids[i];
    if (!list) {
      list = [];
      for (let c = this.firstChilds[i]!; c >= 0; c = this.nextSiblings[c]!) list.push(this.node(c));
      this.kids[i] = list;
    }
    return list;
  }

  /** The number of children, without building the list of a node that has none (a token, an identifier). */
  childCountOf(i: number): number {
    const list = this.kids[i];
    if (list) return list.length;
    let n = 0;
    for (let c = this.firstChilds[i]!; c >= 0; c = this.nextSiblings[c]!) n++;
    return n;
  }

  namedChildrenOf(i: number): FlatNode[] {
    let list = this.namedKids[i];
    if (!list) {
      list = [];
      for (let c = this.firstChilds[i]!; c >= 0; c = this.nextSiblings[c]!) if ((this.flags[c]! & NAMED) !== 0) list.push(this.node(c));
      this.namedKids[i] = list;
    }
    return list;
  }

  /** The field id of a name this tree uses, else 0 (no node of the tree has that field). */
  fieldIdOf(name: string): number {
    return this.fieldIdByName.get(name) ?? 0;
  }

  /** The ids of every type spelled `types`, as a set (several grammar symbols can share a name). */
  typeIdsNamed(types: string | string[]): Set<number> {
    const key = typeof types === "string" ? types : types.join("\0");
    let set = this.wantedMemo.get(key);
    if (!set) {
      set = new Set();
      for (const name of typeof types === "string" ? [types] : types) for (const id of this.typeIdsByName.get(name) ?? []) set.add(id);
      this.wantedMemo.set(key, set);
    }
    return set;
  }

  /** Registered by the copy for each type / field it meets. */
  registerType(id: number, name: string): void {
    this.typeNames[id] = name;
    const list = this.typeIdsByName.get(name);
    if (list) list.push(id);
    else this.typeIdsByName.set(name, [id]);
  }
  registerField(id: number, name: string): void {
    this.fieldNames[id] = name;
    this.fieldIdByName.set(name, id);
  }

  /** The row and column of a source offset: rows split at `\n`, the column counted in the source's own units. */
  pointAt(offset: number): Point {
    let starts = this.lineStarts;
    if (!starts) {
      starts = [0];
      const text = this.source;
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
      this.lineStarts = starts;
    }
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { row: lo, column: offset - starts[lo]! };
  }

  /** The ERROR nodes (outermost only), the MISSING nodes and the bytes under the ERROR nodes, as `parseErrorsOf` counts them. */
  errorStats(): { nodes: number; missing: number; bytes: number } {
    let nodes = 0;
    let missing = 0;
    let bytes = 0;
    for (let i = 0; i < this.count; ) {
      const f = this.flags[i]!;
      if ((f & ERROR_TYPE) !== 0) {
        nodes++;
        bytes += this.ends[i]! - this.starts[i]!;
        i = this.subtreeEnds[i]!;
        continue;
      }
      if ((f & MISSING) !== 0) missing++;
      i++;
    }
    return { nodes, missing, bytes };
  }
}

/** Whether a tree is a flat copy. */
export function isFlatTree(tree: unknown): tree is FlatTree {
  return tree instanceof FlatTree;
}

/**
 * Copy `tree` into a `FlatTree` with one cursor walk. `source` is the text the tree was parsed from: offsets index it
 * (web-tree-sitter reports UTF-16 units for a string input — `flat-tree.test.ts` holds that for non-ASCII sources).
 */
export function flattenTree(tree: Tree, source: string): FlatTree {
  const count = tree.rootNode.descendantCount;
  const typeIds = new Uint16Array(count);
  const fieldIds = new Uint16Array(count);
  const flags = new Uint8Array(count);
  const starts = new Uint32Array(count);
  const ends = new Uint32Array(count);
  const parents = new Int32Array(count);
  const firstChilds = new Int32Array(count).fill(-1);
  const nextSiblings = new Int32Array(count).fill(-1);
  const prevSiblings = new Int32Array(count).fill(-1);
  const subtreeEnds = new Int32Array(count);
  const flat = new FlatTree(source, count, typeIds, fieldIds, flags, starts, ends, parents, firstChilds, nextSiblings, prevSiblings, subtreeEnds);

  const seenType = new Uint8Array(65536);
  const seenField = new Uint8Array(65536);
  // Whether a type is named is the type's own property (an alias is a symbol of its own): asked once per type.
  const namedType = new Uint8Array(65536);
  const cursor = tree.walk();
  // The node index at each depth of the path, and the last child seen under each, to link siblings.
  let path = new Int32Array(256);
  let last = new Int32Array(256);
  let depth = 0;
  let i = 0;
  let errorType = -1;

  const enter = (): void => {
    const tid = cursor.nodeTypeId;
    const fid = cursor.currentFieldId;
    if (seenType[tid] === 0) {
      seenType[tid] = 1;
      if (cursor.nodeIsNamed) namedType[tid] = NAMED;
      const name = cursor.nodeType;
      flat.registerType(tid, name);
      if (name === "ERROR") errorType = tid;
    }
    if (fid !== 0 && seenField[fid] === 0) {
      seenField[fid] = 1;
      flat.registerField(fid, cursor.currentFieldName!);
    }
    typeIds[i] = tid;
    fieldIds[i] = fid;
    const start = cursor.startIndex;
    const end = cursor.endIndex;
    // Only an empty node can be MISSING (the parser inserts it where it expected a token).
    flags[i] = namedType[tid]! | (start === end && cursor.nodeIsMissing ? MISSING : 0) | (tid === errorType ? ERROR_TYPE : 0);
    starts[i] = start;
    ends[i] = end;
    if (depth === 0) parents[i] = -1;
    else {
      const parent = path[depth - 1]!;
      parents[i] = parent;
      const before = last[depth - 1]!;
      if (before < 0) firstChilds[parent] = i;
      else {
        nextSiblings[before] = i;
        prevSiblings[i] = before;
      }
      last[depth - 1] = i;
    }
    if (depth === path.length) {
      const grownPath = new Int32Array(depth * 2);
      grownPath.set(path);
      path = grownPath;
      const grownLast = new Int32Array(depth * 2);
      grownLast.set(last);
      last = grownLast;
    }
    path[depth] = i;
    last[depth] = -1;
    depth++;
    i++;
  };

  enter();
  walking: for (;;) {
    if (cursor.gotoFirstChild()) {
      enter();
      continue;
    }
    for (;;) {
      subtreeEnds[path[--depth]!] = i;
      if (cursor.gotoNextSibling()) {
        enter();
        break;
      }
      if (!cursor.gotoParent()) break walking;
    }
  }
  cursor.delete();
  propagateErrors(flags, parents, count);
  // An external scanner can insert a zero-width MISSING token the cursor never visits (a Kotlin statement end): the
  // real tree still says `hasError` for it and its ancestors. Rare (broken files), so ask the real nodes then.
  if (tree.rootNode.hasError) readErrorFlags(tree, flags);
  return flat;
}

/** `hasError` of every node as the real tree answers it, in the walk's own preorder. */
function readErrorFlags(tree: Tree, flags: Uint8Array): void {
  const cursor = tree.walk();
  let i = 0;
  for (;;) {
    if (cursor.currentNode.hasError) flags[i] = flags[i]! | HAS_ERROR;
    i++;
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        cursor.delete();
        return;
      }
    }
  }
}

/** `hasError`: a node is an error or missing, or holds one. Children follow their parent in preorder, so one reverse pass. */
function propagateErrors(flags: Uint8Array, parents: Int32Array, count: number): void {
  for (let i = count - 1; i >= 0; i--) {
    const f = flags[i]!;
    if ((f & (ERROR_TYPE | MISSING | HAS_ERROR)) !== 0) {
      flags[i] = f | HAS_ERROR;
      const p = parents[i]!;
      if (p >= 0) flags[p] = flags[p]! | HAS_ERROR;
    }
  }
}
