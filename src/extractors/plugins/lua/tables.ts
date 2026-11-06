import type { ClassInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";

/** `function Club.new` / `function Club:train` — a function stored in a table. */
const TABLE_FUNCTION = /^([A-Za-z_]\w*)[.:]([A-Za-z_]\w*)$/;
/** `obj:method(`, `obj:method "x"`, `obj:method{…}`. */
const COLON_CALL = /([A-Za-z_]\w*):([A-Za-z_]\w*)\s*(?=[({"'])/g;
/** `local c = Club.new(…)` / `= Club:new(…)` / `= setmetatable({}, Club)`. */
const LOCAL_CONSTRUCTED = /^\s*local\s+([A-Za-z_]\w*)\s*=\s*(?:([A-Za-z_]\w*)[.:]new\s*\(|setmetatable\s*\(\s*\{[^}]*\}\s*,\s*([A-Za-z_]\w*)\s*\))/;
/** `setmetatable(Sub, { __index = Base })` / `setmetatable(Sub, Base)`. */
const INHERITS = /\bsetmetatable\s*\(\s*([A-Za-z_]\w*)\s*,\s*\{?\s*(?:__index\s*=\s*)?([A-Za-z_]\w*)\s*\}?\s*\)/g;
const RETURNED_TABLE = /^return\s+([A-Za-z_]\w*)\s*;?\s*$/m;
const REQUIRE_BINDING = /^\s*local\s+([A-Za-z_]\w*)\s*=\s*require\b/;

/**
 * Lua has no classes: a table holding functions is one. After the file is read, the functions it stores in a
 * table (`function Club.new`, `function Club:train`) become that table's class, its methods named bare —
 * so a typed receiver, `self:warmup()` and `Club.new(…)` link as members of a class — and the table the file
 * returns (`return M`) is its module, which a `local r = require("referee")` binding stands for.
 * `obj:method()` keeps its receiver (`obj.method`), a local built by `Club.new(…)` is a `Club`, and
 * `setmetatable(Sub, { __index = Base })` makes `Base` its base.
 */
export function luaTables(analysis: FileAnalysis, rawSource: string): void {
  const lines = rawSource.split(/\r?\n/);
  const all = (): FunctionInfo[] => [...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)];

  // `obj:method()` is a call on `obj`: the scans name it `method` alone.
  for (const fn of all()) {
    if (fn.calls.length === 0) continue;
    const colonAt = new Map<string, string>();
    for (let n = fn.line; n <= Math.min(fn.endLine, lines.length); n++) {
      for (const m of (lines[n - 1] ?? "").matchAll(COLON_CALL)) colonAt.set(`${n}\0${m[2]}`, m[1]!);
    }
    if (colonAt.size === 0) continue;
    for (const call of fn.calls) {
      if (call.name.includes(".")) continue;
      const receiver = colonAt.get(`${call.line}\0${call.name}`);
      if (receiver) call.name = `${receiver}.${call.name}`;
    }
  }

  // A local built by its table's constructor is an instance of it.
  for (const fn of all()) {
    for (let n = fn.line; n <= Math.min(fn.endLine, lines.length); n++) {
      const m = LOCAL_CONSTRUCTED.exec(lines[n - 1] ?? "");
      const type = m?.[2] ?? m?.[3];
      if (!m || !type) continue;
      const locals = (fn.localTypes ??= []);
      if (!locals.some((l) => l.name === m[1])) locals.push({ name: m[1]!, type });
    }
  }

  // A `local r = require("referee")` binding stands for the module the file returns.
  for (const imp of analysis.imports) {
    if (!imp.specifiers.length || !REQUIRE_BINDING.test(lines[imp.line - 1] ?? "")) continue;
    imp.isNamespace = true;
  }

  // The tables holding functions become classes.
  const byTable = new Map<string, Array<{ fn: FunctionInfo; leaf: string }>>();
  for (const fn of analysis.functions) {
    const m = TABLE_FUNCTION.exec(fn.name);
    if (!m) continue;
    (byTable.get(m[1]!) ?? byTable.set(m[1]!, []).get(m[1]!)!).push({ fn, leaf: m[2]! });
  }
  if (byTable.size === 0) return;
  const returned = RETURNED_TABLE.exec(rawSource.trimEnd())?.[1];
  const moved = new Set<FunctionInfo>();
  const classes: ClassInfo[] = [];
  for (const [table, members] of byTable) {
    for (const { fn, leaf } of members) {
      fn.name = leaf;
      moved.add(fn);
    }
    const methods = members.map((x) => x.fn);
    classes.push({
      name: table,
      extends: null,
      implements: [],
      decorators: [],
      methods,
      properties: [],
      isExported: returned === table,
      line: Math.min(...methods.map((f) => f.line)),
      endLine: Math.max(...methods.map((f) => f.endLine)),
      kind: "class",
    });
  }
  for (const m of rawSource.matchAll(INHERITS)) {
    const sub = classes.find((c) => c.name === m[1]);
    if (sub && !sub.extends && m[2] !== sub.name) sub.extends = m[2]!;
  }
  analysis.functions = analysis.functions.filter((f) => !moved.has(f));
  analysis.classes.push(...classes);
  const stale = new Set<string>();
  for (const [table, members] of byTable) for (const x of members) stale.add(`${table}.${x.leaf}`).add(`${table}:${x.leaf}`);
  analysis.exports = analysis.exports.filter((e) => !stale.has(e.name));
  for (const c of classes) if (c.isExported) analysis.exports.push({ name: c.name, kind: "class", line: c.line });
}
