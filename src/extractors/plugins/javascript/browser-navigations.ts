import type { Node, Tree } from "web-tree-sitter";
import type { BrowserNavigation } from "../../../types/analysis.js";

/**
 * Pages a browser drives the app to — the address bar of an end-to-end suite:
 *  - Playwright / Puppeteer: `page.goto("/clubs/1")`, `this.page.goto(…)`, any `…Page.goto(…)`
 *    (a fixture renamed `{ authenticatedPage: page }`, a second page);
 *  - Cypress: `cy.visit("/login")`;
 *  - WebdriverIO: `browser.url("/garage")`.
 * The argument is the app path: a literal, a template whose holes are parameters
 * (`/clubs/${club.id}` → `/clubs/{}`), a URL on the dev server's host
 * (`http://localhost:4173/clubs` → `/clubs`) or under a base expression
 * (`${baseURL}/clubs`), or a constant of the function or module holding one.
 * Another host is no page of the app. Where the file is test code is core's
 * question; the plugin reports every such call.
 */
export function extractBrowserNavigations(tree: Tree, sourceText: string): BrowserNavigation[] {
  if (!GATE.test(sourceText)) return [];
  const out: BrowserNavigation[] = [];
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "member_expression") continue;
    const method = fn.childForFieldName("property")?.text ?? "";
    const receiver = fn.childForFieldName("object")?.text ?? "";
    const driver =
      (method === "goto" && PAGE_RECEIVER.test(receiver)) || (method === "visit" && receiver === "cy") || (method === "url" && receiver === "browser");
    if (!driver) continue;
    const arg = call.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment");
    if (!arg) continue;
    const written = arg.type === "identifier" ? constantValue(arg) : pathText(arg);
    const path = written === null ? null : appPath(written);
    if (path) out.push({ path, line: call.startPosition.row + 1 });
  }
  return out;
}

/** Cheap gate: some driver call is in the file. */
const GATE = /\.goto\(|\bcy\.visit\(|\bbrowser\.url\(/;

/** A page object: `page`, `this.page`, `adminPage`, `this.context.page`. */
const PAGE_RECEIVER = /(?:^|\.)(?:page|\w*Page)$/;

/** A local dev server: the host a suite's `baseURL` names. */
const LOCAL_HOST = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?=\/|$)/i;

/**
 * A string or template as written, holes kept as `${…}`; anything else (a call, a
 * concatenation) is no path stated here.
 */
function pathText(n: Node): string | null {
  if (n.type === "string") return n.text.slice(1, -1);
  if (n.type !== "template_string") return null;
  let text = "";
  for (const c of n.namedChildren) {
    if (c.type === "template_substitution") text += "${}";
    else if (c.type === "string_fragment") text += c.text;
    else if (c.type === "escape_sequence") text += c.text.slice(1);
  }
  // A template with no named fragments (`\`/clubs\``): its text between the backticks.
  return n.namedChildren.length === 0 ? n.text.slice(1, -1) : text;
}

/**
 * The app path a written address names: the path with holes as `{}` segments
 * (a segment holding a hole is a parameter), the query and fragment cut; null
 * for another host, a relative address or a bare hole.
 */
function appPath(written: string): string | null {
  let p = written.trim();
  const local = LOCAL_HOST.exec(p);
  if (local) p = p.slice(local[0].length) || "/";
  else if (/^\$\{\}(?=\/)/.test(p)) p = p.slice(3);
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  p = p.split(/[?#]/)[0]!;
  const segs = p.split("/").map((seg) => (seg.includes("${}") ? "{}" : seg));
  return segs.join("/") || "/";
}

/**
 * The string a `const` in scope holds: the nearest declaration of the name in an
 * enclosing block, function or the module, before the call.
 */
function constantValue(id: Node): string | null {
  const name = id.text;
  for (let scope: Node | null = id.parent; scope; scope = scope.parent) {
    if (!SCOPES.has(scope.type)) continue;
    for (const st of scope.namedChildren) {
      if (st.startIndex >= id.startIndex) break;
      const decl = st.type === "export_statement" ? st.namedChildren.find((c) => c.type === "lexical_declaration") : st;
      if (decl?.type !== "lexical_declaration" || !decl.text.startsWith("const")) continue;
      for (const d of decl.namedChildren) {
        if (d.type !== "variable_declarator" || d.childForFieldName("name")?.text !== name) continue;
        const value = d.childForFieldName("value");
        return value ? pathText(value) : null;
      }
    }
  }
  return null;
}

const SCOPES = new Set(["program", "statement_block"]);
