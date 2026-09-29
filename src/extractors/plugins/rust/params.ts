import type { ParamInfo } from "../../../types/analysis.js";
import { stripTypeModifiers } from "../../shared/type-parser.js";

/** Bare the Rust type identifier — `&'a mut User` / `*const User` → `User`. */
export function stripRustTypeModifiers(raw: string): string {
  return stripTypeModifiers(raw, "rust");
}

/**
 * One parameter: `name: Type`, `mut name: Type`, or a destructuring pattern
 * the web frameworks lean on — `Json(payload): Json<CreateUser>`,
 * `Path((id, sub)): Path<(u64, u64)>`, `Query(ListParams { page, .. }): Query<ListParams>`.
 * The pattern side is split from the type at the first `:` that is not a
 * `::` path separator; the name is the bound identifier inside the pattern
 * (the first lowercase binding for a tuple/struct pattern), the type is kept
 * whole so `bindParam` can read the extractor wrapper off it.
 */
export function parseRustParam(paramText: string): ParamInfo | null {
  const trimmed = paramText.trim();
  if (!trimmed) return null;
  if (trimmed === "self" || trimmed === "&self" || trimmed === "&mut self" || /^&?(?:mut\s+)?self\s*:/.test(trimmed)) return null;
  const colon = trimmed.search(/(?<!:):(?!:)/);
  if (colon < 0) return null;
  const pattern = trimmed.slice(0, colon).trim().replace(/^mut\s+/, "");
  const type = trimmed.slice(colon + 1).trim();
  if (!type) return null;
  let name: string | null = null;
  if (/^[a-zA-Z_]\w*$/.test(pattern)) name = pattern;
  else {
    // `Json(payload)` / `Path((id, sub))` / `Query(Params { page, .. })` — the
    // first identifier that is a binding, not a type/wrapper name.
    const idents = [...pattern.matchAll(/[a-zA-Z_]\w*/g)].map((m) => m[0]);
    name = idents.find((id) => /^[a-z_]/.test(id) && id !== "mut" && id !== "ref") ?? null;
  }
  if (!name) return null;
  return { name, type: stripRustTypeModifiers(type), defaultValue: null };
}
