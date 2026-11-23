import { UNCLAIMED_CODE_EXTENSIONS } from "../extractors/registry.js";
import type { UnreadCode } from "../types/analysis.js";
import { vendoredRoots } from "./dead-code.js";
import { byOrdinal } from "./ordinal.js";

const MAX_EXTENSIONS = 10;
const MAX_EXAMPLES = 3;

/**
 * Code files no plugin reads, counted by extension from their paths alone (discovery already matched them by name;
 * nothing is opened). Files under a vendored root (`third_party/`, `vendored/`…) and minified or generated names
 * are left out. `paths` come sorted (discovery sorts them), so each extension's examples are its first three. Largest first, capped at 10 extensions with 3 example paths each; empty when there are none.
 */
export function summarizeUnreadCode(paths: readonly string[]): UnreadCode[] {
  const posix = paths.map((p) => p.replace(/\\/g, "/"));
  const vendored = vendoredRoots(posix).map((r) => `${r}/`);
  const byExtension = new Map<string, string[]>();
  for (const path of posix) {
    if (vendored.some((r) => path.startsWith(r) || path.includes(`/${r}`))) continue;
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    if (/\.(?:min|generated|g)\.[a-z]+$/.test(base)) continue;
    const dot = base.lastIndexOf(".");
    const ext = dot >= 0 ? base.slice(dot) : "";
    if (!UNCLAIMED_CODE_EXTENSIONS.has(ext)) continue;
    const list = byExtension.get(ext) ?? [];
    list.push(path);
    byExtension.set(ext, list);
  }
  return [...byExtension]
    .map(([extension, files]) => ({ extension, language: UNCLAIMED_CODE_EXTENSIONS.get(extension)!, files: files.length, examples: files.slice(0, MAX_EXAMPLES) }))
    .sort((a, b) => b.files - a.files || byOrdinal(a.extension, b.extension))
    .slice(0, MAX_EXTENSIONS);
}

/** The one line `analyze` prints and the first line `clarifydoc_status` shows, or null when nothing is unread. */
export function unreadCodeLine(unread: readonly UnreadCode[] | undefined): string | null {
  if (!unread?.length) return null;
  const total = unread.reduce((n, u) => n + u.files, 0);
  const shown = unread.slice(0, 4).map((u) => `${u.files} ${u.language} (${u.extension})`).join(", ");
  return `${total} code file${total === 1 ? "" : "s"} no plugin reads, so they are not in the map: ${shown}${unread.length > 4 ? `, … ${unread.length - 4} more` : ""}`;
}
