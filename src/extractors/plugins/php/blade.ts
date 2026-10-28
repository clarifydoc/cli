import type { ImportInfo, InteractiveElementInfo, ScreenInfo } from "../../../types/analysis.js";
import { extractHtmlInteractiveElements } from "../html/index.js";
import { handlerOf } from "../shared/element-requests.js";

/**
 * Laravel Blade templates (`resources/views/**.blade.php`) as UI screens —
 * the JSP treatment applied to Laravel's view tier. Blade files reach the PHP
 * plugin (they ARE .php), but before this they contributed nothing to the
 * Screens & UI pane, so a Laravel app's routes had no pages to anchor to.
 *
 * Screens: one `blade-view` per .blade.php file; caption from `<title>` or
 * `@section('title', '…')`.
 *
 * Interactive elements: the html plugin's extractors run on the markup —
 * Blade's `{{ … }}` echoes and `@directives` don't interfere with tag-level
 * scanning. Gated on Blade directives in the source (the hook has no file
 * path), so plain PHP class files never grow phantom buttons.
 */

const BLADE_FILE_RE = /\.blade\.php$/i;
/** Blade-authored content: a directive or an echo — present in practice in every template — or,
 *  in a partial with neither, Alpine.js markup (`x-data`, `@click=`). */
const BLADE_MARKER_RE =
  /@(extends|section|yield|include|includeIf|csrf|method|foreach|endforeach|if|endif|auth|guest|push|stack)\b|\{\{\s*[$\w]|\sx-(?:data|on:\w+)\s*=|\s@(?:click|submit|change|input|keyup|keydown)[.=]|\swire:[\w.-]+\s*=/;

/** `@section('title', 'Product Catalog')` → "Product Catalog". */
const SECTION_TITLE_RE = /@section\s*\(\s*['"]title['"]\s*,\s*['"]([^'"]+)['"]/;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

export function extractBladeScreens(sourceText: string, filePath: string): ScreenInfo[] {
  if (!BLADE_FILE_RE.test(filePath)) return [];

  const base = filePath
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(BLADE_FILE_RE, "");

  const caption =
    sourceText.match(SECTION_TITLE_RE)?.[1] ??
    sourceText.match(TITLE_TAG_RE)?.[1]?.trim().replace(/\s+/g, " ") ??
    null;

  return [
    {
      name: base,
      formType: "blade-view",
      caption: caption || null,
      dimensions: null,
      components: [],
      filePath,
      routePath: null,
      navigatesTo: [],
    },
  ];
}

/** `{{ route('clubs.show', $club) }}` — the URL of a named route, as an attribute value. */
const ROUTE_ECHO_RE = /\{\{\s*route\(\s*(['"])([\w.-]+)\1[^}]*\}\}|\{!!\s*route\(\s*(['"])([\w.-]+)\3[^!]*!!\}/g;
/** What a route echo is rewritten to, so the html reader takes it for an app path. */
const ROUTE_MARK = "/__route__/";

/**
 * A Livewire action (`wire:click="releasePlayer({{ $player->id }})"`,
 * `wire:click.prevent="signPlayer"`, `<form wire:submit="save">`): the
 * component method the element calls on the server. Spelled as the event
 * directive the html reader takes a handler from, modifiers dropped. A magic
 * action (`$set('x', 1)`, `$refresh`, `$dispatch('saved')`, `$parent.save()`)
 * calls no method of the component and is left alone.
 */
const WIRE_ACTION_RE = /(^|\s)wire:(click|dblclick|submit|change|input|keyup|keydown|keypress|focus|blur|mouseenter|mouseleave)(?:\.[\w-]+)*\s*=\s*("[^"$]*"|'[^'$]*')/g;
/** `wire:model.live="search"`: the field the control binds (its `updatedSearch` hook runs on change). */
const WIRE_MODEL_RE = /(?:^|\s)wire:model(?:\.[\w-]+)*\s*=\s*(?:"([A-Za-z_][\w.]*)"|'([A-Za-z_][\w.]*)')/g;
const BOUND_CONTROLS: ReadonlySet<InteractiveElementInfo["element"]> = new Set(["input", "select", "textarea"]);

export function extractBladeInteractiveElements(sourceText: string): InteractiveElementInfo[] {
  if (!BLADE_MARKER_RE.test(sourceText)) return [];
  // A named route's URL stands in as a marked path the html reader keeps as the
  // request; every other `{{ … }}` / `{!! … !!}` echo body is blanked: they are
  // runtime values, and a `$product->id` inside one carries a `>` that would
  // terminate the html extractor's tag-attribute scan mid-attribute.
  const lines = sourceText
    .split(/\r?\n/)
    // Dots spelled `~`: a marked `clubs.show` must not read as a file with an extension.
    .map((l) => l.replace(ROUTE_ECHO_RE, (_m, _q, name: string | undefined, _q2, name2: string | undefined) => ROUTE_MARK + (name ?? name2)!.replace(/\./g, "~"))
      .replace(/\{\{.*?\}\}|\{!!.*?!!\}/g, "")
      .replace(WIRE_ACTION_RE, "$1x-on:$2=$3"));
  // A form or link to a named route requests `route:<name>`, which the Laravel view
  // resolver maps to the route's controller action; literal paths are left to that resolver too.
  const elements = extractHtmlInteractiveElements(lines, { requests: true });
  if (sourceText.includes("wire:model")) bindWireModels(lines, elements);
  return elements.map((el) => {
    if (!el.request) return el;
    if (!el.request.target.startsWith(ROUTE_MARK)) return { ...el, handler: el.handler ?? handlerOf(el.request.method, el.request.target) };
    const name = el.request.target.slice(ROUTE_MARK.length).replace(/~/g, ".");
    return { ...el, handler: handlerOf(el.request.method, "/" + name.replace(/\./g, "/")), request: { method: el.request.method, target: `route:${name}` } };
  });
}

/** Each `wire:model` names the field its control binds, in order on its line, as a Blazor `@bind` does. */
function bindWireModels(lines: string[], elements: InteractiveElementInfo[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes("wire:model")) continue;
    const controls = elements.filter((e) => e.line === i + 1 && BOUND_CONTROLS.has(e.element) && e.handler === null);
    let k = 0;
    for (const m of lines[i]!.matchAll(WIRE_MODEL_RE)) {
      const control = controls[k++];
      if (!control) break;
      control.event = "bind";
      control.handler = (m[1] ?? m[2])!;
    }
  }
}

/** `@vite(['js/pages/clubs/show.js', 'sass/app.scss'])` / `@vite('resources/js/app.ts')` — the entry points a view loads. */
const VITE_DIRECTIVE_RE = /@vite\s*\(\s*(\[[^\]]*\]|(['"])[^'"]+\2)/g;
const SCRIPT_ENTRY_RE = /\.(?:[cm]?js|jsx|ts|tsx)$/i;
/** `@extends('layout.app')`, `@include('partials.club-card', […])`, `@component('alerts.box')`: a view by its dotted name. */
const VIEW_DIRECTIVE_RE = /@(?:extends|include|includeIf|component|each)\s*\(\s*(['"])([\w.-]+)\1/g;
/** `<x-layout.range />`, `<x-club-card :club="$club">`: an anonymous component under `views/components`. */
const COMPONENT_TAG_RE = /<x-([a-z0-9][\w.-]*)(?=[\s/>])/g;
const NOT_A_VIEW_COMPONENT = new Set(["slot", "dynamic-component"]);

/**
 * What a Blade view loads, as imports: the scripts of its `@vite` directive (its
 * behaviour, as a `<script src>` is a plain page's; stylesheets are left out),
 * and the views it is built from — the layout it extends, the partials it
 * includes, the `<x-…>` components it renders — spelled as their files under
 * the views directory (`layout/app.blade.php`), so a handler a partial names
 * can be looked up in the scripts of the pages that include it.
 */
export function bladeImports(sourceText: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  const seen = new Set<string>();
  const lineAt = (index: number) => sourceText.slice(0, index).split("\n").length;
  const add = (source: string, index: number) => {
    if (seen.has(source)) return;
    seen.add(source);
    out.push({ source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: lineAt(index) });
  };
  if (sourceText.includes("@vite")) {
    for (const m of sourceText.matchAll(VITE_DIRECTIVE_RE)) {
      for (const s of m[1]!.matchAll(/(['"])([^'"]+)\1/g)) {
        const source = s[2]!.trim();
        if (SCRIPT_ENTRY_RE.test(source)) add(source, m.index!);
      }
    }
  }
  for (const m of sourceText.matchAll(VIEW_DIRECTIVE_RE)) add(`${m[2]!.replace(/\./g, "/")}.blade.php`, m.index!);
  for (const m of sourceText.matchAll(COMPONENT_TAG_RE)) {
    if (!NOT_A_VIEW_COMPONENT.has(m[1]!)) add(`components/${m[1]!.replace(/\./g, "/")}.blade.php`, m.index!);
  }
  return out;
}
