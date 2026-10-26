import type { RouteFact } from "../../../types/analysis.js";

/**
 * A server code file that serves a directory of static files at a path
 * (Express `app.use(express.static(path.join(__dirname, "public")))`,
 * `app.use("/docs", express.static("site"))`): the pages inside are served at
 * that path, not at their place in the repository. Emitted by the server's
 * plugin as a route fact; the page plugin moves its page routes accordingly.
 */
export const STATIC_MOUNT_FACT = "static-mount";

export interface StaticMount {
  /** The path the directory is served under (`/` when the mount names none). */
  prefix: string;
  /** The directory, relative to the declaring file's directory, `./` and `../` resolved by the reader. */
  dir: string;
}

const STATIC_USE_RE =
  /\.use\(\s*(?:(['"`])([^'"`]*)\1\s*,\s*)?express\.static\(\s*(?:path\.(?:join|resolve)\([^()]*?,\s*(['"`])([^'"`]+)\3\s*\)|(['"`])([^'"`]+)\5)/g;

/** The static mounts a server file declares. */
export function staticMountFacts(sourceText: string): RouteFact[] {
  if (!sourceText.includes("express.static(")) return [];
  const out: RouteFact[] = [];
  for (const m of sourceText.matchAll(STATIC_USE_RE)) {
    const prefix = m[2] ?? "/";
    const dir = (m[4] ?? m[6] ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!dir || /^[a-z]+:|^\//i.test(dir)) continue;
    out.push({ kind: STATIC_MOUNT_FACT, line: sourceText.slice(0, m.index).split("\n").length, data: { prefix, dir } satisfies StaticMount });
  }
  return out;
}
