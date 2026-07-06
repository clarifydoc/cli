/**
 * Join a route prefix and a child path into one normalized path
 * (`/api` + `/x` → `/api/x`, `/seller` + `product-list` → `/seller/product-list`).
 * Collapses duplicate slashes and treats a bare `/` child as "the prefix itself".
 * Shared by every extractor that composes nested route prefixes (Express
 * mounts, nested react-router `<Route>`s, …).
 */
export function joinRoutePath(prefix: string, path: string): string {
  const head = prefix.replace(/\/+$/, "");
  const tail = path === "/" ? "" : path;
  if (!head) return tail || "/";
  const joined = tail === "" || tail.startsWith("/") ? head + tail : `${head}/${tail}`;
  return joined.replace(/\/{2,}/g, "/") || "/";
}
