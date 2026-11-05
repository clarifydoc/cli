import type { Tree } from "web-tree-sitter";

/**
 * Whether the file starts a browser app — the call that mounts its root component, and with it
 * the router every page of the app renders under:
 *  - Vue: `createApp(App)…mount("#app")` (`createApp` from `vue`), Vue 2 `new Vue({ … })`;
 *  - Angular: `bootstrapApplication(AppComponent, …)`, `platformBrowserDynamic().bootstrapModule(AppModule)`;
 *  - React: `createRoot(el).render(…)`, `hydrateRoot(…)`, `ReactDOM.render(…)`;
 *  - Svelte: `mount(App, { target })`, `new App({ target })` (`App` a `.svelte` import).
 * Each only where the file imports the framework's function, so a project's own `createApp`
 * (a store action of that name) is none. The line of the mounting call, or undefined.
 */
export function extractAppMount(_tree: Tree, sourceText: string): { line: number } | undefined {
  if (!GATE.test(sourceText)) return undefined;
  for (const { imports, call } of MOUNTS) {
    if (!imports.test(sourceText)) continue;
    const m = call.exec(sourceText);
    if (m) return { line: sourceText.slice(0, m.index).split("\n").length };
  }
  return undefined;
}

const GATE = /\b(?:createApp|Vue|bootstrapApplication|bootstrapModule|createRoot|hydrateRoot|render|mount)\s*\(/;

/** `import { a, b } from "<module>"` naming `name`. */
const named = (name: string, module: string) => new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]${module}['"]`);

const MOUNTS: Array<{ imports: RegExp; call: RegExp }> = [
  { imports: named("createApp", "vue"), call: /(?<!function\s+)\bcreateApp\s*\(/ },
  { imports: /import\s+Vue\s+from\s*['"]vue['"]/, call: /\bnew\s+Vue\s*\(/ },
  { imports: named("bootstrapApplication", "@angular/platform-browser"), call: /\bbootstrapApplication\s*\(/ },
  { imports: named("platformBrowserDynamic", "@angular/platform-browser-dynamic"), call: /\.bootstrapModule\s*\(/ },
  { imports: named("(?:createRoot|hydrateRoot)", "react-dom(?:/client)?"), call: /\b(?:createRoot|hydrateRoot)\s*\(/ },
  { imports: /import\s+(?:\*\s+as\s+)?ReactDOM\s+from\s*['"]react-dom(?:\/client)?['"]/, call: /\bReactDOM\.(?:render|hydrate|createRoot|hydrateRoot)\s*\(/ },
  { imports: named("(?:mount|hydrate)", "svelte"), call: /\b(?:mount|hydrate)\s*\(\s*\w+\s*,\s*\{[^}]*\btarget\b/ },
  { imports: /import\s+\w+\s+from\s*['"][^'"]+\.svelte['"]/, call: /\bnew\s+\w+\s*\(\s*\{[^}]*\btarget\s*:/ },
];
