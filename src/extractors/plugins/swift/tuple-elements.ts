import { splitTopLevel } from "../../shared/split-top-level.js";
import { matchingParen } from "../shared/text-scan.js";

/**
 * The element types of a Swift tuple type a function declares it returns, in order, for a tuple pattern
 * (`let (club, player) = load()`): `(Club, Player)` and the labelled `(club: Club, player: Player)` (labels
 * dropped). Null for any other type: an optional tuple, one element (`(Club)` is just `Club`), a class.
 */
export function swiftTupleElements(returnType: string): string[] | null {
  const text = returnType.trim();
  // The opening parenthesis must close at the end: `(A, B) -> (C)` is a function type.
  if (!text.startsWith("(") || matchingParen(text, 0) !== text.length - 1) return null;
  // An arrow inside an element (`(cb: (Club) -> Void, club: Club)`) is no closing bracket.
  const elements = splitTopLevel(text.slice(1, -1).replace(/->/g, ARROW), { brackets: "()<>[]", quotes: "", trim: true, tail: "keep" })
    .map((p) => p.replaceAll(ARROW, "->").replace(/^[A-Za-z_]\w*\s*:\s*/, ""));
  return elements.length >= 2 && elements.every((e) => e !== "") ? elements : null;
}

const ARROW = "\u2192";
