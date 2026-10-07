/**
 * Django URL syntax → the `{name}` path notation every route row uses.
 *
 *   path("documents/<int:pk>/notes/")            → documents/{pk}/notes/
 *   re_path(r"^documents/(?P<pk>[^/.]+)/$")      → documents/{pk}/
 *   re_path(r"^versions/(?P<version_id>\d+)/?$") → versions/{version_id}/
 *
 * Converted in the plugin, not left to the linker: a regex route carries `?`,
 * `/` and `$` that a path normalizer would read as a query, a separator and a
 * literal. Unnamed groups and character classes become `{}`; an optional group
 * is dropped.
 */
export function djangoRoute(route: string, regex: boolean): string {
  return regex ? fromRegex(route) : fromPath(route);
}

function fromPath(route: string): string {
  return route.replace(/<(?:[\w.]+:)?([A-Za-z_]\w*)>/g, "{$1}");
}

function fromRegex(re: string): string {
  const body = re.replace(/^\^/, "").replace(/(\\Z|\$)$/, "");
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "(") {
      const end = closing(body, i);
      if (end === -1) break;
      const group = body.slice(i + 1, end);
      const named = /^\?P<([A-Za-z_]\w*)>/.exec(group);
      let next = end + 1;
      const optional = body[next] === "?";
      while (/[?*+]/.test(body[next] ?? "")) next++;
      // `(\.(?P<format>[a-z0-9]+))?` — an optional group is not part of the path.
      if (!optional) out += named ? `{${named[1]}}` : "{}";
      i = next - 1;
      continue;
    }
    if (c === "[") {
      const end = body.indexOf("]", i + 1);
      if (end === -1) break;
      let next = end + 1;
      while (/[?*+]/.test(body[next] ?? "")) next++;
      if (body[next] === "{") next = body.indexOf("}", next) + 1 || next;
      out += "{}";
      i = next - 1;
      continue;
    }
    if (c === "\\" && i + 1 < body.length) {
      const e = body[++i]!;
      out += /[dwsDWS]/.test(e) ? "{}" : e;
      continue;
    }
    if (c === "?" || c === "*" || c === "+") continue; // a quantifier on what came before: `/?` is `/`
    out += c;
  }
  return out;
}

function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Django joins prefixes as plain strings: `api/` + `documents/` → `api/documents/`. The row path gets one leading `/`. */
export function joinDjango(...parts: string[]): string {
  return ("/" + parts.join("")).replace(/\/{2,}/g, "/");
}
