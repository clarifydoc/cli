/** Small builders for type names and member rows the plugins share (a leaf module; type imports only). */
import type { PropertyInfo } from "../../../types/analysis.js";

/** A dotted qualifier dropped from the front of a type name (`typing.Optional` → `Optional`, `System.Collections.List` → `List`): every leading `Name.` segment. */
export function dropDottedQualifier(name: string): string {
  return name.replace(/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\./, "");
}

/** A public property row; `readonly` for a record-style field (`isReadonly`), mutable by default. */
export function publicProperty(name: string, type: string | null, readonly = false): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: readonly };
}
