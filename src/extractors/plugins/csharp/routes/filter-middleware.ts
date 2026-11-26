import type { Node } from "web-tree-sitter";
import { findChildByType } from "../../../shared/node-helpers.js";

/** ASP.NET runs these on `IAsyncAuthorizationFilter` / `IAuthorizationFilter` / action filters. */
export function filterEntryMethods(typeName: string): string[] {
  const simple = typeName.replace(/.*\./, "");
  if (/Authorization/i.test(simple)) {
    return [`${simple}.OnAuthorizationAsync`, `${simple}.OnAuthorization`];
  }
  return [`${simple}.OnActionExecutionAsync`, `${simple}.OnActionExecuting`];
}

function attributeName(attr: Node): string | null {
  const name = attr.childForFieldName("name")?.text ?? null;
  if (!name) return null;
  return name.replace(/.*\./, "").replace(/(?<=\w)Attribute$/, "");
}

function isNamedAttributeArgument(arg: Node): boolean {
  return arg.namedChildren.some((c) => c.type === "name_equals" || c.type === "name_colon" || c.type === "assignment_expression");
}

/** First positional `typeof(T)` on `[ServiceFilter(typeof(T))]` / `[TypeFilter(…)]`. */
function filterTypeFromAttr(attr: Node): string | null {
  const argList = findChildByType(attr, "attribute_argument_list");
  if (argList) {
    for (const arg of argList.children) {
      if (arg.type !== "attribute_argument" || isNamedAttributeArgument(arg)) continue;
      const typeofExpr = findChildByType(arg, "typeof_expression");
      if (typeofExpr) {
        const inner = typeofExpr.children.find((c) => c.type !== "typeof" && c.type !== "(" && c.type !== ")");
        if (inner?.text) return inner.text.replace(/\s+/g, "");
      }
    }
  }
  const m = /typeof\s*\(\s*([\w.]+)\s*\)/.exec(attr.text.replace(/\s+/g, " "));
  return m ? m[1]! : null;
}

/** Middleware methods a list of filter attributes names (`RouteInfo.middlewareCalls`). */
/**
 * `[ServiceFilter(typeof(X))]` / `[TypeFilter(typeof(X))]` on controllers and Razor `PageModel` classes land in
 * `RouteInfo.filters` and name the filter type's pipeline entry in `middlewareCalls` — `OnAuthorizationAsync` /
 * `OnAuthorization` when the type name says Authorization, otherwise action-filter methods (class-level filters on
 * a page model reach every handler, see razor-pages.ts).
 */
export function filterMiddlewareCalls(attrs: readonly Node[]): string[] {
  const out: string[] = [];
  for (const attr of attrs) {
    const name = attributeName(attr);
    if (name !== "ServiceFilter" && name !== "TypeFilter") continue;
    const type = filterTypeFromAttr(attr);
    if (type) out.push(...filterEntryMethods(type));
  }
  return [...new Set(out)];
}

/** Same as `filterMiddlewareCalls`, from texts already on `RouteInfo.filters`. */
export function filterMiddlewareCallsFromTexts(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const compact = text.replace(/\s+/g, " ");
    const m = /^(?:Service|Type)Filter\s*\(\s*typeof\s*\(\s*([\w.]+)\s*\)/i.exec(compact);
    if (m) out.push(...filterEntryMethods(m[1]!));
  }
  return [...new Set(out)];
}