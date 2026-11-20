import type { ValueOutHook, ValueHop } from "../../types/language-plugin.js";

/** `Task<User>` → `User` when `Task` is one of the language's async result types; otherwise as written. */
export function awaitedType(written: string, asyncTypes: readonly string[] | undefined): string {
  if (!asyncTypes?.length) return written;
  const open = written.indexOf("<");
  if (open <= 0 || !written.endsWith(">")) return written;
  const name = written.slice(0, open).trim().split(/\.|::/).pop() ?? "";
  // `*Result` names a family by suffix: Rust's `io::Result`, `anyhow::Result`, `FlowyResult`.
  if (!asyncTypes.some((t) => (t.startsWith("*") ? name.endsWith(t.slice(1)) : t === name))) return written;
  const body = written.slice(open + 1, -1);
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return body.slice(0, i).trim();
  }
  return body.trim();
}

/** What a plugin states about taking a value out of a declared type; `valueOut` builds the manifest hook from it. */
export interface ValueOutTables {
  /** Calls that take the value out of a wrapper, and the wrappers (by simple name) each unwraps. */
  calls?: Readonly<Record<string, readonly string[]>>;
  /** The property form: members that hold the value inside a wrapper. */
  members?: Readonly<Record<string, readonly string[]>>;
  /** Calls that take ONE element out of a declared list or map. */
  elementCalls?: readonly string[];
  /** A list's element or a map's VALUE as the type is written; null for any other type. */
  elementOf?: (type: string) => string | null;
  /** The member an index read `x[i]` calls (Kotlin `operator fun get`); its presence makes `x[i]` a step the linker reads, taking an element out of a list or map. */
  index?: string;
}

/**
 * The manifest's `valueOut` hook from a plugin's tables. A wrapper hop (`calls`/`members`) takes the first type
 * argument of a listed wrapper; an element hop (`elementCalls`, an index step) takes `elementOf`. Own keys only:
 * `toString` is no unwrapping call.
 */
export function valueOut(tables: ValueOutTables): ValueOutHook {
  const wrappersOf = (hop: ValueHop): readonly string[] | undefined => {
    if (hop.index) return undefined;
    const table = hop.call ? tables.calls : tables.members;
    return table && Object.hasOwn(table, hop.name) ? table[hop.name] : undefined;
  };
  const isElement = (hop: ValueHop): boolean => hop.index ? !!tables.index : hop.call && !!tables.elementCalls?.includes(hop.name);
  return {
    ...(tables.index ? { index: tables.index } : {}),
    takes(hop) {
      const wrapper = !!wrappersOf(hop);
      const element = isElement(hop);
      return wrapper || element ? { wrapper, element } : null;
    },
    at(declared, hop) {
      const wrappers = wrappersOf(hop);
      const element = isElement(hop);
      if (!wrappers && !element) return null;
      const written = declared.trim();
      const open = written.indexOf("<");
      const wrapper = open > 0 ? written.slice(0, open).trim().split(/\.|::/).pop() ?? "" : "";
      if (!written.endsWith(">")) return null;
      if (wrappers?.includes(wrapper)) return { type: awaitedType(written, wrappers), wrapper, kind: "wrapper" };
      const inner = element ? tables.elementOf?.(written) : null;
      return inner ? { type: inner, wrapper, kind: "element" } : null;
    },
  };
}
