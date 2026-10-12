import type {
  FileAnalysis,
  ImportInfo,
  InteractiveElementInfo,
  ScreenComponentInfo,
  ScreenInfo,
  SubComponentInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { pluralize } from "../shared/inflection.js";
import { extractHtmlInteractiveElements } from "../html/index.js";

/**
 * Rails ERB views. The Ruby inside `<% %>` / `<%= %>` is what makes a view a
 * screen of the app: the forms and buttons that send requests (`form_with`,
 * `form_for`, `form_tag`, `button_to`), the links that navigate (`link_to`),
 * and the partials it composes (`render 'form'`). None of that is a call the
 * Ruby plugin sees — a view is not a `.rb` file — so a Rails app had API
 * routes and models but no screens at all.
 *
 * Per file (`postExtract`, which knows the file's path):
 *   - each request-sending helper becomes an interactive element carrying
 *     `request: { method, target }` — the route helper it names
 *     (`edit_user_path`) or a literal path. Its handler is the helper for a GET
 *     and `<verb>_<helper>` otherwise (`delete_user_path`), so a "Show" link and a
 *     "Delete" button on the same helper stay two handlers. A model form
 *     (`form_with model: @user`) posts by Rails' convention: to the plural helper
 *     from a `new` view or a `_form` partial, PATCH to the singular one from an
 *     `edit` view;
 *   - inline-JS handlers and plain controls come from the HTML reader, on the
 *     markup with every ERB tag blanked;
 *   - `render 'x'` / `render partial: 'shared/x'` is a sub-component and an
 *     import of the partial file (`_x.html.erb`), resolved from the view root
 *     (`…/app/views/`) or the view's own directory;
 *   - a view that is not a partial, a layout or a mailer template is a screen
 *     named `controller#action` from its path (`users/edit` → `users#edit`).
 *
 * Which controller action a helper reaches is a project-level join against the
 * Rails routes: `RailsViewResolver` (rails-view-resolver.ts).
 */

/** Every ERB tag: `<%= … %>`, `<% … %>`, `<%- … -%>`, comments `<%# … %>`. */
const ERB_TAG_RE = /<%(=|-|#)?([\s\S]*?)-?%>/g;
/** A Rails route helper named in the arguments: `edit_user_path`, `users_url`. */
const ROUTE_HELPER_RE = /\b([a-z_][a-z0-9_]*_(?:path|url))\b/;
/** A literal app path as an argument: `"/super_admin/sign_in"`. */
const LITERAL_PATH_RE = /["'](\/[^"'\s#?]*)[^"']*["']/;
/** `method: :delete`, `method: "patch"`, `data: { turbo_method: :delete }`, `"data-turbo-method": "delete"`. */
const METHOD_OPTION_RE = /\b(?:method|turbo_method|"data-turbo-method"|'data-turbo-method')\s*(?::|=>)\s*:?["']?(get|post|put|patch|delete)\b/i;

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** Path of the view relative to its `views/` root (`users/edit.html.erb` → `users/edit`), or null outside one. */
function viewKey(filePath: string): { root: string; key: string } | null {
  const m = /^(.*?(?:^|\/)views\/)(.+?)(?:\.[a-z0-9_+-]+)?\.erb$/i.exec(filePath);
  return m ? { root: m[1]!, key: m[2]! } : null;
}

/** Relative import source of a partial named `shared/header` (or `form`) as rendered from `filePath`. */
function partialImportSource(name: string, filePath: string): string {
  const dir = filePath.slice(0, filePath.lastIndexOf("/") + 1);
  const view = viewKey(filePath);
  const slash = name.lastIndexOf("/");
  const file = `${name.slice(0, slash + 1)}_${name.slice(slash + 1)}.html`;
  if (slash < 0 || !view) return `./${file}`;
  // `shared/header` is relative to the views root; walk up from the view's directory to it.
  const depth = dir.slice(view.root.length).split("/").filter(Boolean).length;
  return `${"../".repeat(depth) || "./"}${file}`;
}

interface Request {
  method: string;
  target: string;
}

/** The request a helper sends, from its argument text, or null when it names none. */
function requestOf(args: string, defaultMethod: string): Request | null {
  const helper = ROUTE_HELPER_RE.exec(args)?.[1];
  const literal = helper ? null : LITERAL_PATH_RE.exec(args)?.[1];
  const target = helper ?? literal;
  if (!target) return null;
  const method = (METHOD_OPTION_RE.exec(args)?.[1] ?? defaultMethod).toUpperCase();
  return { method, target };
}

/** Rails' model-form convention: `@user` posts to `users_path`, or PATCHes `user_path` from an edit view. */
function modelFormRequest(model: string, view: { key: string } | null): Request {
  const action = view?.key.split("/").pop() ?? "";
  if (action === "edit") return { method: "PATCH", target: `${model}_path` };
  return { method: "POST", target: `${pluralize(model)}_path` };
}

/** Handler name for a request: the helper for a GET, `<verb>_<helper>` otherwise. */
function handlerOf(request: Request): string {
  const base = request.target.replace(/^\//, "").replace(/[^\w]+/g, "_") || "root";
  return request.method === "GET" ? base : `${request.method.toLowerCase()}_${base}`;
}

export function extractErbView(analysis: FileAnalysis, source: string): void {
  const filePath = analysis.filePath;
  const view = viewKey(filePath);
  const elements: InteractiveElementInfo[] = [];
  const subComponents: SubComponentInfo[] = [];
  const imports: ImportInfo[] = [];
  const components: ScreenComponentInfo[] = [];
  const navigatesTo = new Set<string>();
  let caption: string | null = null;

  const component = (name: string, componentType: string, category: ScreenComponentInfo["category"], line: number, events: string[]): void => {
    components.push({ name, componentType, category, caption: null, position: null, align: null, visible: true, children: [], events, dataBindings: [], line });
  };
  const element = (kind: InteractiveElementInfo["element"], event: string, request: Request, line: number, helper: string): void => {
    const handler = handlerOf(request);
    elements.push({ element: kind, event, handler, line, request });
    component(request.target, helper, kind === "link" ? "navigation" : kind === "form" ? "container" : "action", line, [`${event}: ${handler}`]);
    if (kind === "link" && request.method === "GET") navigatesTo.add(request.target);
  };

  ERB_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ERB_TAG_RE.exec(source)) !== null) {
    if (m[1] === "#") continue;
    const code = m[2]!.trim();
    const line = lineAt(source, m.index);
    let h: RegExpExecArray | null;
    if ((h = /^render\s*\(?\s*(?:partial:\s*)?["']([\w/.-]+)["']/.exec(code))) {
      const name = h[1]!;
      const importSource = partialImportSource(name, filePath);
      subComponents.push({ name: name.split("/").pop()!, importSource, props: [], line });
      imports.push({ source: importSource, specifiers: [], isDefault: false, isNamespace: false, isType: false, line });
      component(name, "partial", "container", line, []);
    } else if ((h = /^(form_with|form_for|form_tag)\b\s*\(?([\s\S]*)$/.exec(code))) {
      const args = h[2]!;
      const urlArg = /\burl:\s*([^,)]+)/.exec(args)?.[1];
      const model = h[1] === "form_with" ? /\bmodel:\s*@?([a-z_]\w*)/.exec(args)?.[1] : h[1] === "form_for" ? /^\s*@?([a-z_]\w*)\b/.exec(args)?.[1] : undefined;
      const request = urlArg !== undefined ? requestOf(urlArg + " " + args, "POST")
        : h[1] === "form_tag" ? requestOf(args, "POST")
        : model ? { ...modelFormRequest(model, view), ...(METHOD_OPTION_RE.test(args) ? { method: METHOD_OPTION_RE.exec(args)![1]!.toUpperCase() } : {}) }
        : null;
      if (request) element("form", "submit", request, line, h[1]!);
    } else if ((h = /^button_to\b\s*\(?([\s\S]*)$/.exec(code))) {
      const request = requestOf(h[1]!, "POST");
      if (request) element("button", "click", request, line, "button_to");
    } else if ((h = /^link_to\b\s*\(?([\s\S]*)$/.exec(code))) {
      const request = requestOf(h[1]!, "GET");
      if (request) element("link", "click", request, line, "link_to");
    } else if ((h = /^(?:content_for|provide)\s*\(?\s*:title\s*,\s*["']([^"']+)["']/.exec(code))) {
      caption ??= h[1]!;
    }
  }

  // The markup's own controls and inline handlers, every ERB tag blanked first.
  const markup = source.replace(ERB_TAG_RE, (t) => t.replace(/[^\n]/g, " "));
  for (const el of extractHtmlInteractiveElements(markup.split("\n"))) {
    if (el.element === "form" && el.handler === null) continue; // the form helpers above carry the request
    elements.push(el);
  }
  // A native `<form action="/x" method="post">` sends a request too.
  for (const f of markup.matchAll(/<form\b([^>]*)>/gi)) {
    const action = /\baction\s*=\s*["'](\/[^"'?#]*)/i.exec(f[1]!)?.[1];
    if (!action) continue;
    const method = (/\bmethod\s*=\s*["'](\w+)/i.exec(f[1]!)?.[1] ?? "GET").toUpperCase();
    element("form", "submit", { method, target: action }, lineAt(markup, f.index!), "form");
  }
  caption ??= /<h1\b[^>]*>([^<]+)<\/h1>/i.exec(markup)?.[1]?.trim() || null;

  elements.sort((a, b) => a.line - b.line);
  analysis.interactiveElements = elements;
  analysis.subComponents = subComponents;
  analysis.imports = [...analysis.imports, ...imports];

  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const isScreen = view !== null && !base.startsWith("_") && !/(?:^|\/)(?:layouts|mailers?)\//.test(view.key) && !/_mailer\//.test(view.key);
  if (isScreen) {
    const parts = view.key.split("/");
    const action = parts.pop()!;
    const screen: ScreenInfo = {
      name: `${parts.join("/") || "application"}#${action}`,
      formType: "RailsView",
      caption,
      dimensions: null,
      components: components.sort((a, b) => a.line - b.line),
      filePath,
      routePath: null,
      navigatesTo: [...navigatesTo],
    };
    analysis.screens = [screen];
  }
}

export const erbSpec: RegexLangSpec = {
  language: "erb",
  extensions: [".erb"],
  blockStyle: "brace",
  lineCommentPrefixes: [],
  // A view declares no functions of its own; everything is read in `postExtract`.
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
};
