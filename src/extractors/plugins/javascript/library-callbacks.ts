import type { Node, Tree } from "web-tree-sitter";
import type { CallInfo, FunctionPropBinding } from "../../../types/analysis.js";

/**
 * Option callbacks a library object runs when one of its methods is called — knowledge of the library, kept as
 * data: `const table = useVueTable({ onPaginationChange: (u) => loadPage(u) })` runs `onPaginationChange` when
 * the page calls `table.nextPage()`, though no call in the source says so.
 *
 * Only what the source states is read: the factory must be imported from the library's package (a project
 * function named `useVueTable` is the project's), the options must be an object literal written at the call, and
 * only the options it writes are joined. A callback written in place is a function of its own (`heldFunction`:
 * `<useVueTable:onPaginationChange@21>`); a named one (`onSortingChange: applySort`) is that function.
 *
 * The declarator holding the result records each callback under each method that runs it (`passed: "property"`,
 * `returnedAs: "table.nextPage"`, `CallInfo.libraryOption`), so the linker's dispatch-map join reaches the callback
 * from `table.nextPage()` anywhere in that scope, and a child component handed the object (`<Pager :table="table">`,
 * `<Pager table={table} />`) gets the same callbacks as `table.nextPage` props (`libraryObjectProps`).
 */

interface LibraryObject {
  /** The packages exporting the factories (`@tanstack/vue-table`). */
  packages: RegExp;
  /** The factories, as the package exports them. */
  factories: ReadonlySet<string>;
  /** Each option callback → the methods of the factory's result that run it. */
  runs: Readonly<Record<string, readonly string[]>>;
  /**
   * An option every method of `runs` falls back to when the option of its own feature is not written, with the
   * methods that run it in any case (TanStack Table: `onStateChange`, which `setState`/`reset` run, and every
   * feature setter whose own `on…Change` the call leaves out).
   */
  fallback?: { option: string; methods: readonly string[] };
  /**
   * Methods of the objects the library's own results hand out (`table.getHeaderGroups()` → headers → `header.column`):
   * member path (`column`, `row`) → option → the methods that run it (`header.column.toggleSorting()` runs
   * `onSortingChange`). Held under `holder.<path>.<method>`; a local read off the holder (a loop variable) is a name for it.
   */
  members?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

/** TanStack Table's column and row methods that hand an updater to a state feature's `on…Change` option. */
const TABLE_MEMBERS: NonNullable<LibraryObject["members"]> = {
  column: {
    onSortingChange: ["toggleSorting", "clearSorting", "getToggleSortingHandler"],
    onColumnVisibilityChange: ["toggleVisibility", "getToggleVisibilityHandler"],
  },
  row: {
    onRowSelectionChange: ["toggleSelected", "getToggleSelectedHandler"],
    onExpandedChange: ["toggleExpanded", "getToggleExpandedHandler"],
  },
};

/** A TanStack Table state feature's setter and reset (`setSorting`, `resetSorting`), plus the methods built on them. */
const tableFeature = (feature: string, ...more: string[]): string[] => [`set${feature}`, `reset${feature}`, ...more];

export const LIBRARY_OBJECTS: readonly LibraryObject[] = [
  {
    // TanStack Table v8: every state setter hands its updater to the feature's `on…Change` option.
    packages: /^@tanstack\/(?:(?:vue|react|solid|angular|lit|qwik|preact)-)?table(?:-core)?$/,
    factories: new Set(["useVueTable", "useReactTable", "createSolidTable", "createAngularTable", "useQwikTable", "createTable"]),
    runs: {
      onPaginationChange: tableFeature("Pagination", "setPageIndex", "resetPageIndex", "setPageSize", "resetPageSize", "nextPage", "previousPage", "firstPage", "lastPage"),
      onSortingChange: tableFeature("Sorting"),
      onColumnFiltersChange: tableFeature("ColumnFilters"),
      onGlobalFilterChange: tableFeature("GlobalFilter"),
      onRowSelectionChange: tableFeature("RowSelection", "toggleAllRowsSelected", "toggleAllPageRowsSelected"),
      onColumnVisibilityChange: tableFeature("ColumnVisibility", "toggleAllColumnsVisible"),
      onExpandedChange: tableFeature("Expanded", "toggleAllRowsExpanded"),
      onColumnOrderChange: tableFeature("ColumnOrder"),
      onColumnPinningChange: tableFeature("ColumnPinning"),
      onRowPinningChange: tableFeature("RowPinning"),
      onColumnSizingChange: tableFeature("ColumnSizing"),
      onColumnSizingInfoChange: ["setColumnSizingInfo", "resetHeaderSizeInfo"],
      onGroupingChange: tableFeature("Grouping"),
    },
    fallback: { option: "onStateChange", methods: ["setState", "reset"] },
    // Its columns, headers, cells and rows: `header.column.toggleSorting()` runs the table's `onSortingChange` too.
    members: TABLE_MEMBERS,
  },
  {
    // TanStack Query: `mutation.mutate(x)` / `mutateAsync(x)` call the `mutationFn` the hook was given.
    packages: /^@tanstack\/(?:react|vue|solid|svelte|angular|preact)-query$|^react-query$/,
    factories: new Set(["useMutation", "createMutation", "injectMutation"]),
    runs: { mutationFn: ["mutate", "mutateAsync"] },
  },
];

/** Wrappers an options object or a callback value may sit in. */
const WRAPPERS: ReadonlySet<string> = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression"]);
const FUNCTION_VALUES: ReadonlySet<string> = new Set(["arrow_function", "function_expression"]);

const unwrap = (n: Node | null | undefined): Node | null => {
  let at = n ?? null;
  while (at && WRAPPERS.has(at.type)) at = at.namedChild(0);
  return at;
};

let memoTree: Tree | null = null;
let memoImports = new Map<string, { imported: string; source: string }>();

/** Local name → the name it is imported under and the module, for the file's top-level named imports. */
function importsOf(tree: Tree): Map<string, { imported: string; source: string }> {
  if (tree === memoTree) return memoImports;
  memoTree = tree;
  memoImports = new Map();
  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt?.type !== "import_statement") continue;
    const source = stmt.childForFieldName("source")?.text.slice(1, -1);
    if (!source) continue;
    for (const spec of stmt.descendantsOfType("import_specifier")) {
      const imported = spec?.childForFieldName("name")?.text;
      if (!spec || !imported) continue;
      memoImports.set(spec.childForFieldName("alias")?.text ?? imported, { imported, source });
    }
  }
  return memoImports;
}

/** The module and exported name a file's top-level named import binds a local name to, or null. */
export function importedBinding(tree: Tree, local: string): { imported: string; source: string } | null {
  return importsOf(tree).get(local) ?? null;
}

/** A call building a library object: its factory as the package exports it and the options object it writes. */
export interface LibraryObjectCall {
  library: LibraryObject;
  factory: string;
  options: Node;
}

/**
 * The library object a call builds — `useVueTable({ … })`, `createAngularTable(() => ({ … }))` — when the callee is
 * a factory imported from the library's package and its options are an object literal; else null.
 */
export function libraryObjectCall(call: Node | null): LibraryObjectCall | null {
  if (call?.type !== "call_expression") return null;
  const callee = call.childForFieldName("function");
  if (callee?.type !== "identifier") return null;
  const imp = importsOf(call.tree).get(callee.text);
  const library = imp ? LIBRARY_OBJECTS.find((l) => l.factories.has(imp.imported) && l.packages.test(imp.source)) : undefined;
  if (!imp || !library) return null;
  let options = unwrap(call.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment"));
  // Options handed as a function returning them (`createAngularTable(() => ({ … }))`).
  if (options && FUNCTION_VALUES.has(options.type)) options = unwrap(options.childForFieldName("body"));
  return options?.type === "object" ? { library, factory: imp.imported, options } : null;
}

/** The options a call writes that the library runs as callbacks, each with the methods running it. */
export function statedCallbacks(built: LibraryObjectCall): Array<{ option: string; value: Node; methods: readonly string[] }> {
  const { library, options } = built;
  const stated: Array<{ option: string; value: Node }> = [];
  for (const member of options.namedChildren) {
    if (member?.type === "shorthand_property_identifier") stated.push({ option: member.text, value: member });
    else if (member?.type === "pair") {
      const key = keyText(member.childForFieldName("key"));
      const value = unwrap(member.childForFieldName("value"));
      if (key && value) stated.push({ option: key, value });
    }
  }
  const written = new Set(stated.map((s) => s.option));
  const out: Array<{ option: string; value: Node; methods: readonly string[] }> = [];
  /** The member methods an option runs, as `column.toggleSorting`. */
  const memberMethods = (wanted: (option: string) => boolean): string[] =>
    Object.entries(library.members ?? {}).flatMap(([path, byOption]) => Object.entries(byOption).filter(([option]) => wanted(option)).flatMap(([, methods]) => methods.map((m) => `${path}.${m}`)));
  for (const s of stated) {
    const own = library.runs[s.option];
    if (own) out.push({ ...s, methods: [...own, ...memberMethods((option) => option === s.option)] });
    else if (library.fallback?.option === s.option) {
      // What runs the fallback: its own methods, and every setter whose own option is not written.
      const unclaimed = Object.entries(library.runs).filter(([option]) => !written.has(option)).flatMap(([, methods]) => methods);
      out.push({ ...s, methods: [...library.fallback.methods, ...unclaimed, ...memberMethods((option) => !written.has(option))] });
    }
  }
  return out;
}

/** The held name of a callback written in place as a library object's option: `<useVueTable:onPaginationChange@21>`. */
export function libraryCallbackName(fn: Node): string | null {
  const pair = fn.parent;
  if (pair?.type !== "pair" || unwrap(pair.childForFieldName("value"))?.id !== fn.id) return null;
  const key = keyText(pair.childForFieldName("key"));
  if (!key) return null;
  // The object, then the call it is the options of: `f({ … })`, `f(() => ({ … }))`.
  let at: Node | null = pair.parent;
  for (let hop = 0; hop < 4 && at && at.type !== "arguments"; hop++) at = at.parent;
  const built = at?.type === "arguments" ? libraryObjectCall(at.parent) : null;
  if (!built || built.options.id !== pair.parent?.id) return null;
  return statedCallbacks(built).some((s) => s.option === key && s.value.id === fn.id) ? `<${built.factory}:${key}@${fn.startPosition.row + 1}>` : null;
}

/** One callback a library object's method runs: under `holder.method`, the function `name` the option states. */
export interface LibraryObjectMember {
  method: string;
  /** The held function's name, or the named function as written (`applySort`). */
  name: string;
  node: Node;
  /** `factory:option`, `CallInfo.libraryOption`. */
  option: string;
}

/**
 * The callbacks a declared library object's methods run: `const table = useVueTable({ onPaginationChange: … })`
 * → `table` and, per method, the callback. `namesFunction` says whether a name written as a value can be a
 * function (`onSortingChange: applySort`); a value that is neither written in place nor named is left out.
 */
export function libraryObjectMembers(
  declarator: Node,
  heldName: (fn: Node) => string | null,
  namesFunction: (site: Node, name: string) => boolean,
): { holder: string; members: LibraryObjectMember[] } | null {
  if (declarator.type !== "variable_declarator") return null;
  const name = declarator.childForFieldName("name");
  const built = name?.type === "identifier" ? libraryObjectCall(unwrap(declarator.childForFieldName("value"))) : null;
  if (!name || !built) return null;
  const members: LibraryObjectMember[] = [];
  for (const s of statedCallbacks(built)) {
    const fn = FUNCTION_VALUES.has(s.value.type) ? heldName(s.value) : (s.value.type === "identifier" || s.value.type === "shorthand_property_identifier") && namesFunction(s.value, s.value.text) ? s.value.text : null;
    if (!fn) continue;
    for (const method of new Set(s.methods)) members.push({ method, name: fn, node: s.value, option: `${built.factory}:${s.option}` });
  }
  return members.length > 0 ? { holder: name.text, members } : null;
}

/**
 * The library object a name in markup is where it is used: the `const`/`let` declaring it in an enclosing block or
 * at the top level, when that declares a library object (`<Pager table={table} />` inside the component holding
 * `const table = useReactTable({ … })`).
 */
export function libraryObjectAt(
  site: Node,
  name: string,
  heldName: (fn: Node) => string | null,
  namesFunction: (site: Node, name: string) => boolean,
): LibraryObjectMember[] | null {
  for (let p = site.parent; p; p = p.parent) {
    if (p.type !== "statement_block" && p.type !== "program") continue;
    for (const stmt of p.namedChildren) {
      const decl = stmt?.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
      if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;
      for (const d of decl.namedChildren) {
        if (d?.type === "variable_declarator" && d.childForFieldName("name")?.text === name) return libraryObjectMembers(d, heldName, namesFunction)?.members ?? null;
      }
    }
  }
  return null;
}

/**
 * The library objects a file's functions hold, from their `CallInfo.libraryOption` records: holder → each method and
 * the callback it runs (`table` → `nextPage` → `<useVueTable:onPaginationChange@21>`).
 */
export function libraryHoldersOf(functions: ReadonlyArray<{ calls: readonly CallInfo[] }>): Map<string, Array<{ method: string; name: string }>> {
  const out = new Map<string, Array<{ method: string; name: string }>>();
  for (const fn of functions) {
    for (const c of fn.calls) {
      if (c.passed !== "property" || !c.libraryOption || !c.returnedAs) continue;
      const dot = c.returnedAs.indexOf(".");
      if (dot <= 0) continue;
      const holder = c.returnedAs.slice(0, dot);
      const list = out.get(holder) ?? out.set(holder, []).get(holder)!;
      const method = c.returnedAs.slice(dot + 1);
      if (!list.some((m) => m.method === method && m.name === c.name)) list.push({ method, name: c.name });
    }
  }
  return out;
}

/**
 * A library object handed to a child as a prop (`<Pager :table="table" />`): the child's `table.nextPage()` runs
 * the callback the holder's call states, so each method is a function prop of its own (`table.nextPage`), which the
 * prop-callback resolver joins to the child's calls of it.
 */
export function libraryObjectProps(bindings: readonly FunctionPropBinding[], membersOf: (holder: string) => ReadonlyArray<{ method: string; name: string }> | null | undefined): FunctionPropBinding[] {
  const out: FunctionPropBinding[] = [];
  for (const b of bindings) {
    for (const m of membersOf(b.handler) ?? []) out.push({ component: b.component, prop: `${b.prop}.${m.method}`, handler: m.name, line: b.line });
  }
  return out;
}

/**
 * The names a library object's members are called by when read off a local derived from the holder: a loop variable
 * over what the holder hands out (`for (const header of headerGroup.headers)`, `.map((header) => …)`). A member held
 * as `column.toggleSorting` is called `header.column.toggleSorting()` on a header or cell and `column.toggleSorting()`
 * on the column itself, so both spellings are the local's.
 */
export function derivedMemberKeys(local: string, method: string): string[] {
  const dot = method.indexOf(".");
  return dot < 0 ? [] : [`${local}.${method}`, `${local}.${method.slice(dot + 1)}`];
}

/** Iteration methods whose callback parameter is one element of the receiver. */
const ITERATORS: ReadonlySet<string> = new Set(["map", "forEach", "flatMap", "filter", "find", "some", "every"]);

/** The identifier an expression starts from: `table` of `table.getHeaderGroups()`, `headerGroup` of `headerGroup.headers`. */
function rootIdentifier(n: Node | null | undefined): string | null {
  let at = unwrap(n);
  for (let hop = 0; at && hop < 12; hop++) {
    if (at.type === "identifier") return at.text;
    if (at.type === "call_expression") at = unwrap(at.childForFieldName("function"));
    else if (at.type === "member_expression" || at.type === "subscript_expression") at = unwrap(at.childForFieldName("object"));
    else if (at.type === "await_expression") at = unwrap(at.namedChild(0));
    else return null;
  }
  return null;
}

/** The element a callback of an iteration method takes, and the root identifier of what it iterates: `rows.map((row) => …)`. */
function iterationOf(fn: Node): { param: string; root: string; call: Node } | null {
  if (!FUNCTION_VALUES.has(fn.type) || fn.parent?.type !== "arguments") return null;
  const call = fn.parent.parent;
  const callee = call?.type === "call_expression" ? call.childForFieldName("function") : null;
  if (callee?.type !== "member_expression" || !ITERATORS.has(callee.childForFieldName("property")?.text ?? "")) return null;
  if (fn.parent.namedChildren.find((a) => a?.type !== "comment")?.id !== fn.id) return null;
  const root = rootIdentifier(callee.childForFieldName("object"));
  const single = fn.childForFieldName("parameter");
  const first = single ?? fn.childForFieldName("parameters")?.namedChildren.find((p) => p?.type !== "comment") ?? null;
  const id = first?.type === "identifier" ? first : first?.childForFieldName("pattern");
  return root && id?.type === "identifier" && call ? { param: id.text, root, call } : null;
}

/**
 * The locals a block derives from a library object by iterating what it hands out — the callbacks of
 * `table.getHeaderGroups().map((group) => group.headers.map((header) => …))` name `group` and `header` —, in source order.
 */
export function derivedLocalsIn(scope: Node, holder: string): string[] {
  const roots = new Set([holder]);
  const out: string[] = [];
  for (const fn of scope.descendantsOfType(["arrow_function", "function_expression"])) {
    const it = fn ? iterationOf(fn) : null;
    if (it && roots.has(it.root) && !roots.has(it.param)) {
      roots.add(it.param);
      out.push(it.param);
    }
  }
  return out;
}

/**
 * The library object a name is derived from where markup or script uses it: the callback parameter an iteration over
 * the holder's results binds (`headers.map((header) => <Cell header={header} />)`) — its holder's members.
 */
export function derivedObjectAt(
  site: Node,
  name: string,
  heldName: (fn: Node) => string | null,
  namesFunction: (site: Node, name: string) => boolean,
): LibraryObjectMember[] | null {
  for (let p = site.parent, hops = 0; p && hops < 200; p = p.parent, hops++) {
    const it = iterationOf(p);
    if (!it || it.param !== name) continue;
    return libraryObjectAt(it.call, it.root, heldName, namesFunction) ?? derivedObjectAt(it.call, it.root, heldName, namesFunction);
  }
  return null;
}

/**
 * The locals a Vue template derives from the library objects its script holds: `v-for="header in headerGroup.headers"`
 * with `headerGroup` from `table.getHeaderGroups()` — local → the holder.
 */
export function derivedTemplateLocals(template: string, holders: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (!template.includes("v-for")) return out;
  for (const m of template.matchAll(/\bv-for\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const loop = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\)?\s+(?:in|of)\s+([\s\S]*)$/.exec(m[1] ?? m[2] ?? "");
    const root = /^\s*([A-Za-z_$][\w$]*)/.exec(loop?.[2] ?? "")?.[1];
    if (!loop || !root) continue;
    const holder = holders.has(root) ? root : out.get(root);
    if (holder && !holders.has(loop[1]!)) out.set(loop[1]!, holder);
  }
  return out;
}

/**
 * Hold a library object's member callbacks under the locals a template derives from it too: each record held under
 * `table.column.toggleSorting` is held again under `header.column.toggleSorting` and `header.toggleSorting` for every
 * local derived from `table` (`derivedTemplateLocals`), where the template's calls are made.
 */
export function addDerivedLibraryMembers(functions: ReadonlyArray<{ calls: CallInfo[] }>, locals: ReadonlyMap<string, string>): void {
  if (locals.size === 0) return;
  for (const fn of functions) {
    const more: CallInfo[] = [];
    for (const c of fn.calls) {
      if (c.passed !== "property" || !c.libraryOption || !c.returnedAs) continue;
      const dot = c.returnedAs.indexOf(".");
      const holder = c.returnedAs.slice(0, dot);
      for (const [local, from] of locals) {
        if (from !== holder) continue;
        for (const key of derivedMemberKeys(local, c.returnedAs.slice(dot + 1))) more.push({ ...c, returnedAs: key });
      }
    }
    fn.calls.push(...more);
  }
}

function keyText(key: Node | null | undefined): string | null {
  if (!key) return null;
  if (key.type === "property_identifier") return key.text;
  if (key.type === "string") {
    const t = key.text.slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
  }
  return null;
}
