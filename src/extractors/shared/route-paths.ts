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

/**
 * Join route-path pieces into a rooted path: always one leading `/`, empty
 * segments dropped, no trailing `/` (`["/api/", "x"]` → `/api/x`, nothing → `/`).
 * By default every slash inside a piece splits it, so a doubled `/` collapses;
 * `collapse: false` trims only each piece's ends and keeps an inner `a//b` as written
 * (the spelling Ktor, Laravel, NestJS and Javalin/Spark already had).
 */
export function joinRootedPath(parts: ReadonlyArray<string | null | undefined>, opts: { collapse?: boolean } = {}): string {
  const collapse = opts.collapse ?? true;
  const segments = collapse
    ? parts.flatMap((p) => (p ?? "").split("/")).filter(Boolean)
    : parts.map((p) => (p ?? "").replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return "/" + segments.join("/");
}

/**
 * Join a prefix and a path with exactly one `/` between them and no trailing `/`
 * (`/api/` + `/x/` → `/api/x`); an empty result is `/`. The prefix is NOT rooted — `api` + `x`
 * gives `api/x`, as the Crystal, PowerShell and Rust readers always did.
 * `collapse: true` also folds a doubled `/` anywhere (`/a//b` → `/a/b`, Rust's spelling).
 * `prefixOptional: true` returns the path as written when there is no prefix (OCaml, Zig).
 */
export function joinTrimmedPath(
  prefix: string,
  path: string,
  opts: { collapse?: boolean; prefixOptional?: boolean } = {},
): string {
  if (opts.prefixOptional && !prefix) return path;
  if (opts.collapse) return (prefix + "/" + path).replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const joined = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return joined.length > 1 ? joined.replace(/\/+$/, "") : "/";
}
