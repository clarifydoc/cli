import { readFileSync, statSync } from "fs";
import type { FileRouteInput } from "../../../../types/language-plugin.js";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import {
  inferExpoRouterRoutes,
  inferFlatRoutes,
  inferNextRoutes,
  inferNuxtServerRoutes,
  inferReactRouterConfig,
  inferSvelteKitRoutes,
  inferAstroRoutes,
  inferTrpcEndpointFacts,
} from "./file-routes.js";
import { inferNextMiddlewareFacts } from "./next-middleware.js";
import { inferRenderModeFacts } from "./render-mode.js";
import { inferAstroMiddlewareFacts } from "./astro-middleware.js";

/**
 * The routes a file's place states (`AstExtractorHooks.fileRoutes`): Next.js, Nuxt, SvelteKit, Astro, Expo Router
 * and Remix / React Router flat routes, read from the file's path below its own sub-project's root and that
 * sub-project's frameworks. API endpoints read the file's exported handlers; tRPC handlers, middleware guards and
 * render modes are route facts a resolver applies later.
 */
export function placedRoutes(input: FileRouteInput): { routes: RouteInfo[]; facts: RouteFact[] } {
  const { relativePath: routePath, frameworkIds: routeFrameworks, analysis, sourceText, rawSource } = input;
  const routes = [
    ...inferNextRoutes(routePath, analysis, routeFrameworks, sourceText),
    ...inferNuxtServerRoutes(routePath, analysis, routeFrameworks, sourceText),
    ...inferSvelteKitRoutes(routePath, analysis, routeFrameworks, sourceText),
    ...inferAstroRoutes(routePath, analysis, routeFrameworks, rawSource),
    ...inferExpoRouterRoutes(routePath, analysis, routeFrameworks),
    ...inferReactRouterConfig(routePath, sourceText, routeFrameworks).routes,
    ...inferFlatRoutes(routePath, analysis, routeFrameworks, {
      flatRoutes: routeFrameworks.includes("react-router-framework") && /^(?:app|src)\/routes\//.test(routePath.replace(/\\/g, "/")) && usesFlatRoutes(input.absolutePath, routePath),
    }),
  ];
  const facts = [
    ...inferTrpcEndpointFacts(routePath, sourceText, routeFrameworks),
    ...inferNextMiddlewareFacts(routePath, sourceText, routeFrameworks),
    ...inferAstroMiddlewareFacts(routePath, sourceText, routeFrameworks),
    ...inferRenderModeFacts(routePath, sourceText, rawSource, routeFrameworks),
  ];
  return { routes, facts };
}

/** Whether a React Router 7 project's `app/routes.ts` delegates to `flatRoutes()`, per sub-project root. */
const flatRoutesByRoot = new Map<string, boolean>();
function usesFlatRoutes(absolutePath: string, routePath: string): boolean {
  const abs = absolutePath.replace(/\\/g, "/");
  const rel = routePath.replace(/\\/g, "/");
  if (!abs.endsWith(rel)) return false;
  const root = abs.slice(0, abs.length - rel.length);
  // Keyed by the config's mtime too: a long-lived process (the MCP server) sees an edit.
  const dir = rel.split("/")[0];
  for (const ext of ["ts", "js", "mts", "mjs"]) {
    const config = `${root}${dir}/routes.${ext}`;
    let key: string;
    try {
      key = `${config}:${statSync(config).mtimeMs}`;
    } catch {
      continue;
    }
    let hit = flatRoutesByRoot.get(key);
    if (hit === undefined) {
      hit = /\bflatRoutes\s*\(/.test(readFileSync(config, "utf-8"));
      flatRoutesByRoot.set(key, hit);
    }
    return hit;
  }
  return false;
}
