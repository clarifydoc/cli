/**
 * JSON with comments and trailing commas — tsconfig, appsettings, launchSettings.
 * Leaf module: static manifests import it, so it may import nothing but types.
 */

/**
 * Strip JSONC comments and trailing commas, preserving string literals.
 * Required because SvelteKit/NestJS/Vite/T3/Astro all ship JSONC tsconfigs,
 * and .NET reads appsettings with comments allowed.
 */
export function stripJsonc(text: string): string {
  // First pass: walk the string skipping over string-literal spans so // and
  // /* inside strings are preserved.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      // Copy the string verbatim, handling escapes.
      out += ch;
      i++;
      while (i < text.length) {
        const c = text[i]!;
        out += c;
        i++;
        if (c === "\\" && i < text.length) {
          out += text[i];
          i++;
        } else if (c === '"') {
          break;
        }
      }
    } else if (ch === "/" && text[i + 1] === "/") {
      // Line comment — skip to newline.
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      // Block comment — skip to terminator.
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Strip trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** A JSONC document's top-level object, or null when it does not parse to one. */
export function parseJsoncObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(stripJsonc(text.replace(/^﻿/, "")));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Every string leaf of a JSON object as `path → value`, the path joined with
 * `separator` (`{"Services":{"Orders":"…"}}` → `Services:Orders`). Array
 * elements are addressed by index, as .NET configuration binds them.
 */
export function flattenStrings(obj: Record<string, unknown>, separator: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (path) out.push({ key: path, value: v });
      return;
    }
    if (!v || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, path ? path + separator + k : k);
  };
  walk(obj, "");
  return out;
}

/** 1-based line of the first `"<leafKey>": "<value>"` pair in the text, or undefined. */
export function lineOfPair(text: string, leafKey: string, value: string): number | undefined {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`"${esc(leafKey)}"\\s*:\\s*"${esc(JSON.stringify(value).slice(1, -1))}"`).exec(text);
  return m ? text.slice(0, m.index).split("\n").length : undefined;
}
