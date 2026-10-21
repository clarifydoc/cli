import type { CallPattern } from "../shared/regex-base.js";

/** The string literal opening at `at` in the raw line. */
function stringAt(raw: string, at: number): string | null {
  const q = raw[at];
  if (q !== "'" && q !== '"') return null;
  const end = raw.indexOf(q, at + 1);
  const text = end > at ? raw.slice(at + 1, end) : "";
  return /^[\w/]+$/.test(text) ? text : null;
}

/**
 * The templates code names: `render :edit`, `render 'clubs/show'`,
 * `render template: '…'` / `partial: '…'` in an action, and
 * `json.partial! 'api/v1/models/club'` / `partial: '…'` in a view. Each is a
 * call keyed `rails-view:<template|partial>:<path as written>` for the view
 * resolver below. `render json: …` names no template and is no match.
 */
export const RAILS_RENDER_CALL_PATTERNS: CallPattern[] = [
  {
    pattern: /\brender\s*\(?\s*(?:(template|action|partial):\s*)?(?::(\w+)|(['"]))/,
    buildName: (m, raw) => {
      const written = m[2] ?? (raw ? stringAt(raw, m.index + m[0].length - 1) : null);
      if (!written) return { name: "", leafName: "" };
      return { name: "render", leafName: "render", key: `rails-view:${m[1] === "partial" ? "partial" : "template"}:${written}` };
    },
  },
  {
    pattern: /\bpartial!\s*\(?\s*(?:partial:\s*)?(['"])|\bpartial:\s*(['"])/,
    buildName: (m, raw) => {
      const written = raw ? stringAt(raw, m.index + m[0].length - 1) : null;
      return written ? { name: "json.partial!", leafName: "partial!", key: `rails-view:partial:${written}` } : { name: "", leafName: "" };
    },
  },
];
