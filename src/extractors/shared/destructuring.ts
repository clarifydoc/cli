/**
 * Destructuring parameters as written. A plugin names a destructuring parameter by
 * its pattern's text (`ParamInfo.name` `{ table, onRemove: remove, onSave = noop }`,
 * `[first, ...rest]`); these read what such a pattern takes and binds.
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The top-level properties an object pattern takes, each with the local name it binds:
 * `{ table, onRemove: remove, onSave = () => {}, "on-pick": pick, club: { id }, ...rest }` →
 * table → table, onRemove → remove, onSave → onSave, on-pick → pick, club → null (taken apart
 * further). Anything but an object pattern reads as none.
 */
export function destructuredProps(pattern: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const text = pattern.trim();
  if (!text.startsWith("{")) return out;
  for (const raw of splitTopLevel(text.slice(1)) ?? []) {
    const part = raw.trim();
    if (!part || part.startsWith("...")) continue;
    const colon = topLevelIndex(part, ":");
    const eq = topLevelIndex(part, "=");
    if (colon >= 0 && (eq < 0 || colon < eq)) {
      const key = part.slice(0, colon).trim().replace(/^(["'])(.*)\1$/, "$2");
      const bound = withoutDefault(part.slice(colon + 1));
      if (key) out.set(key, IDENTIFIER.test(bound) ? bound : null);
    } else {
      const key = withoutDefault(part);
      if (IDENTIFIER.test(key)) out.set(key, key);
    }
  }
  return out;
}

/**
 * The names a destructuring pattern binds, nested patterns included — never a property key
 * it reads from (`{ refresh: again }` binds `again`) nor a name its defaults use
 * (`{ onSave = noop }` binds `onSave`). Null when `pattern` is no object or array pattern of
 * that shape (`{:keys [a b]}` is another language's).
 */
export function patternBindings(pattern: string): string[] | null {
  const text = pattern.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  const parts = splitTopLevel(text.slice(1));
  if (!parts) return null;
  const out: string[] = [];
  const bind = (target: string): boolean => {
    const t = withoutDefault(target.trim().replace(/^\.\.\./, ""));
    if (IDENTIFIER.test(t)) return out.push(t) > 0;
    const nested = t.startsWith("{") || t.startsWith("[") ? patternBindings(t) : null;
    if (nested) out.push(...nested);
    return !!nested;
  };
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (text.startsWith("[") || part.startsWith("...")) {
      if (!bind(part)) return null;
      continue;
    }
    const colon = topLevelIndex(part, ":");
    const eq = topLevelIndex(part, "=");
    const keyed = colon >= 0 && (eq < 0 || colon < eq);
    if (keyed && !PROPERTY_KEY.test(part.slice(0, colon).trim())) return null;
    if (!bind(keyed ? part.slice(colon + 1) : part)) return null;
  }
  return out;
}

/** An object pattern's property key: a name, a string, a number or a computed `[key]`. */
const PROPERTY_KEY = /^(?:[A-Za-z_$][\w$]*|"[^"]*"|'[^']*'|\d+|\[.+\])$/;

/** A pattern element without its default value (`onSave = () => {}` → `onSave`). */
function withoutDefault(element: string): string {
  const eq = topLevelIndex(element, "=");
  return (eq >= 0 ? element.slice(0, eq) : element).trim();
}

/** `body` (the text after a pattern's opening bracket) split at its top-level commas up to the matching close; null when unclosed. */
function splitTopLevel(body: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = body.indexOf(ch, i + 1);
      if (end < 0) return null;
      i = end;
    } else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) {
        parts.push(body.slice(start, i));
        return parts;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/** The index of `ch` outside brackets and strings in `text` (the `=` of `=>`, `==`, `<=`, `>=`, `!=` never counts), or -1. */
function topLevelIndex(text: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (depth === 0 && c === ch && !(ch === "=" && (text[i + 1] === ">" || text[i + 1] === "=" || /[<>!=]/.test(text[i - 1] ?? "")))) return i;
  }
  return -1;
}
