import type { ClassInfo, FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * Livewire view → component class. A Livewire component (`class SquadList
 * extends Component` under `App\Livewire`) renders a Blade view whose
 * `wire:click="releasePlayer(…)"` / `wire:submit="signPlayer"` call the
 * component's own methods on the server; nothing in the markup names the
 * class. The view is the one the component's `render()` names
 * (`view('livewire.squad-list')`), else the one Livewire's naming rule gives
 * (`App\Livewire\Admin\SquadList` → `livewire/admin/squad-list.blade.php`).
 * Each element whose handler the class declares links from the view's
 * `<component>` anchor to that method, and the view to the component's
 * `mount`/`render` — what the page shows is what they load.
 */

/** A Blade view's name under `views/`, slash-separated (`livewire/squad-list`). */
function bladeViewName(filePath: string): string | null {
  return /(?:^|\/)views\/(.+)\.blade\.php$/i.exec(filePath)?.[1] ?? null;
}

/** Laravel's `Str::kebab` (`SquadList` → `squad-list`). */
function kebab(name: string): string {
  return name.replace(/(.)(?=[A-Z])/g, "$1-").toLowerCase();
}

/** The class is a Livewire component: it extends `Component` from a file that imports Livewire, or sits in a Livewire namespace. */
function isLivewireComponent(a: FileAnalysis, cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const livewireFile = a.imports.some((i) => /^\\?Livewire\\/i.test(i.source)) || /(?:^|\\)Livewire(?:\\|$)/.test(a.declaredNamespace ?? "");
  return livewireFile && (/(?:^|\\)Component$/.test(cls.extends) || /\/Livewire\//.test(a.filePath));
}

/** The views a component renders: those its `render()` names, else Livewire's convention. */
function componentViews(a: FileAnalysis, cls: ClassInfo): string[] {
  const render = cls.methods.find((m) => m.name === "render");
  const named = (render?.calls ?? []).flatMap((c) => {
    const key = c.key?.startsWith("laravel-view:") ? c.key.slice(13).replace(/\./g, "/") : c.key?.startsWith("ci-view:") ? c.key.slice(8) : null;
    return key ? [key] : [];
  });
  if (named.length > 0) return named;
  const ns = (a.declaredNamespace ?? "").replace(/^\\/, "").split("\\");
  const at = ns.findIndex((s) => s === "Livewire");
  if (at < 0) return [];
  return [["livewire", ...ns.slice(at + 1).map(kebab), kebab(cls.name)].join("/")];
}

export class LivewireViewResolver implements DispatchResolver {
  readonly id = "livewire-view";
  readonly languages: Language[] = ["php"];
  readonly priority = 58;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const views = new Map<string, FileAnalysis>();
    for (const a of analyses) {
      const name = bladeViewName(a.filePath);
      if (name && a.interactiveElements.length > 0) views.set(`${a.projectId ?? ""}\0${name}`, a);
    }
    if (views.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const add = (l: SymbolLink): void => {
      const k = `${l.sourceFile}\0${l.sourceLine}\0${l.targetFile}\0${l.targetSymbol}`;
      if (seen.has(k)) return;
      seen.add(k);
      links.push(l);
    };
    for (const a of analyses) {
      for (const cls of a.classes) {
        if (!isLivewireComponent(a, cls)) continue;
        const methods = new Map(cls.methods.map((m) => [m.name, m]));
        for (const name of componentViews(a, cls)) {
          const view = views.get(`${a.projectId ?? ""}\0${name}`);
          if (!view) continue;
          const to = (method: string, line: number, callName: string): void => {
            const m = methods.get(method);
            if (m) add({ sourceFile: view.filePath, sourceSymbol: "<component>", sourceLine: line, callName, targetFile: a.filePath, targetSymbol: `${cls.name}.${m.name}`, targetLine: m.line, confidence: "INFERRED" });
          };
          for (const el of view.interactiveElements) {
            if (!el.handler) continue;
            // A bound field runs its `updated<Field>` hook (`search` → `updatedSearch`).
            if (el.event === "bind") {
              const field = el.handler.split(".")[0]!;
              to(`updated${field.charAt(0).toUpperCase()}${field.slice(1)}`, el.line, el.handler);
            } else {
              to(el.handler, el.line, el.handler);
            }
          }
          to("mount", 1, "mount");
          to("render", 1, "render");
        }
      }
    }
    return links;
  }
}
