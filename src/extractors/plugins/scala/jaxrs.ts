import type { RouteInfo } from "../../../types/analysis.js";

/**
 * JAX-RS resources written in Scala: `@Path("/fixtures")` on a class or trait, a verb marker
 * (`@GET`, `@POST`, …) and an optional `@Path("/{id}")` on each method, stacked above the
 * declaration or sharing its line.
 *
 *   @Path("/fixtures")
 *   class FixtureResource {
 *     @GET @Path("/{id}") def one(id: Int): String = …
 *   }
 *
 * The handler is `Class#method`, so the linker joins that class's method among namesakes. Only
 * a `@Path` class is a resource: a verb outside one is a sub-resource a locator mounts, which
 * this per-file reading cannot place.
 */

const VERB_RE = /@(?:javax\.ws\.rs\.|jakarta\.ws\.rs\.)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;
const PATH_RE = /@(?:javax\.ws\.rs\.|jakarta\.ws\.rs\.)?Path\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/;
const ANNOTATIONS = String.raw`(?:@[\w.]+(?:\([^)]*\))?\s+)*`;
const TYPE_RE = new RegExp(String.raw`^\s*${ANNOTATIONS}(?:(?:private|protected|final|sealed|abstract|case)\s+)*(?:class|trait|object)\s+(\w+)`);
const DEF_RE = new RegExp(String.raw`^\s*${ANNOTATIONS}(?:(?:override|final|protected|private)\s+)*def\s+(\w+)`);

export const JAXRS_SCALA_GATE_RE = /\b(?:javax|jakarta)\.ws\.rs\b/;

const join = (a: string, b: string): string => {
  const parts = [a, b].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return "/" + parts.join("/");
};

export function extractScalaJaxrsRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  let pendingVerb: string | null = null;
  let pendingPath: string | null = null;
  let cls: { name: string; path: string } | null = null;
  // Each type's body ends where its indentation returns: a following top-level type is not nested in it.
  let clsIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    const verb = VERB_RE.exec(line)?.[1];
    const path = PATH_RE.exec(line)?.[1];
    if (verb) pendingVerb = verb;
    if (path !== undefined) pendingPath = path;
    const type = TYPE_RE.exec(line);
    if (type) {
      const indent = line.length - line.trimStart().length;
      if (!cls || indent <= clsIndent) {
        cls = pendingPath !== null ? { name: type[1]!, path: pendingPath } : null;
        clsIndent = indent;
      }
      pendingVerb = null;
      pendingPath = null;
      continue;
    }
    const def = DEF_RE.exec(line);
    if (def) {
      if (cls && pendingVerb) {
        routes.push({
          path: join(cls.path, pendingPath ?? ""),
          httpMethod: pendingVerb,
          kind: "api",
          handler: `${cls.name}#${def[1]}`,
          calls: [],
          middleware: [],
          line: i + 1,
        });
      }
      pendingVerb = null;
      pendingPath = null;
    }
  }
  return routes;
}
