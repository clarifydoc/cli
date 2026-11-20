import type { ValueOutHook, ValueHop } from "../../types/language-plugin.js";
import { awaitedType } from "./awaited-type.js";

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

/** The four answers `takes` gives, shared: a chain walk asks once per hop and allocates nothing. */
const TAKES = {
  wrapper: Object.freeze({ wrapper: true, element: false }),
  element: Object.freeze({ wrapper: false, element: true }),
  both: Object.freeze({ wrapper: true, element: true }),
} as const;

/**
 * The manifest's `valueOut` hook from a plugin's tables. A wrapper hop (`calls`/`members`) takes the first type
 * argument of a listed wrapper; an element hop (`elementCalls`, an index step) takes `elementOf`. Own keys only:
 * `toString` is no unwrapping call.
 */
export function valueOut(tables: ValueOutTables): ValueOutHook {
  const elementCalls = new Set(tables.elementCalls ?? []);
  /** The wrappers a hop unwraps, and whether it takes an element out — the one lookup both questions share. */
  const kindOf = (hop: ValueHop): { wrappers: readonly string[] | undefined; element: boolean } => {
    if (hop.index) return { wrappers: undefined, element: !!tables.index };
    const table = hop.call ? tables.calls : tables.members;
    return {
      wrappers: table && Object.hasOwn(table, hop.name) ? table[hop.name] : undefined,
      element: hop.call && elementCalls.has(hop.name),
    };
  };
  return {
    ...(tables.index ? { index: tables.index } : {}),
    takes(hop) {
      const { wrappers, element } = kindOf(hop);
      return wrappers ? (element ? TAKES.both : TAKES.wrapper) : element ? TAKES.element : null;
    },
    at(declared, hop) {
      const { wrappers, element } = kindOf(hop);
      if (!wrappers && !element) return null;
      const written = declared.trim();
      if (!written.endsWith(">")) return null;
      const open = written.indexOf("<");
      const wrapper = open > 0 ? written.slice(0, open).trim().split(/\.|::/).pop() ?? "" : "";
      if (wrappers?.includes(wrapper)) return { type: awaitedType(written, wrappers), wrapper, kind: "wrapper" };
      const inner = element ? tables.elementOf?.(written) : null;
      return inner ? { type: inner, wrapper, kind: "element" } : null;
    },
  };
}
