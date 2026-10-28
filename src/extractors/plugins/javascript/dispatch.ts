import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { resolveTarget, buildFilePathMap } from "../../shared/link-scoring.js";
import { propFunctionName } from "./markup-calls.js";

/**
 * Component-event dispatch: wire a child component's `emit('save')` to the
 * parent handler bound on its tag (`<SaveDialog @save="onSave">`). The two
 * sides have no name-resolvable call edge — the framework routes the event at
 * runtime — so a click inside the child dead-ended one hop from the screen,
 * even when the parent's handler drives the whole API→DB chain.
 *
 * The join is exact, not name-guessing:
 *   parent's interactive element carries the TAG (`component`) + event + handler
 *   → subComponents maps the tag to the child's import source → file
 *   → the child's `events` (defineEmits / emit() extraction) must declare the event.
 *
 * One link per binding: <child emit-site fn> → <parent handler>, callName
 * `emit:<event>` — the report resolves a child element whose handler is a bare
 * `emit('save')` through exactly this callName. A child used by many parents
 * fans out to each bound handler (the runtime does too, one parent at a time).
 */
export class JsComponentEmitResolver implements DispatchResolver {
  readonly id = "component-emit";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 30;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    const globals = globalComponentFiles(analyses, filePathMap);
    const autoImported = autoImportedComponents(analyses);
    const spanCache = new Map<FileAnalysis, SymbolSpan[]>();
    const spans = (a: FileAnalysis) => spanCache.get(a) ?? spanCache.set(a, spansOf(a)).get(a)!;

    // Every binding of a child's event on its tag: child file → event key → bindings.
    // `bound`: the function a Vue binding is extracted as when it calls anything but one of the file's own functions (`markupFunctions`).
    interface Binding { parent: FileAnalysis; handler: string; child: FileAnalysis; event: string; angular: boolean; bound?: string }
    const bindings = new Map<string, Map<string, Binding[]>>();
    const selectors = angularSelectors(analyses);
    for (const parent of analyses) {
      // Vue's `@save="…"`, and Angular's `(save)="…"` on a component's tag.
      const els = (parent.interactiveElements ?? []).filter(
        (el) => el.element === "custom" && el.component && el.handler && (el.event.startsWith("@") || (el.event.startsWith("(") && el.event.endsWith(")"))),
      );
      if (els.length === 0) continue;

      // Tag → child import source, tolerant of kebab-vs-Pascal (<my-button> / MyButton);
      // a tag the file does not import is the component registered app-wide under that name,
      // else the one the framework imports by its file name (Nuxt's `components/`).
      const subByKey = new Map<string, string>(autoImported.get(parent.projectId ?? "") ?? []);
      for (const [k, file] of globals) subByKey.set(k, file);
      for (const sub of parent.subComponents ?? []) {
        if (sub.importSource && !sub.global) subByKey.set(tagKey(sub.name), sub.importSource);
      }
      for (const el of els) {
        const angular = el.event.startsWith("(");
        // An Angular tag is its component's selector, whichever module declares it.
        const childFile = angular
          ? selectors.get(tagKey(el.component!)) ?? null
          : subByKey.has(tagKey(el.component!)) ? resolveTarget(subByKey.get(tagKey(el.component!))!, parent.filePath, filePathMap) : null;
        const child = childFile ? byPath.get(childFile) : undefined;
        if (!child) continue; // external/library component — nothing to wire
        const event = (angular ? el.event.slice(1, -1) : el.event.slice(1)).split(".")[0]!; // strip @ / () + modifiers
        const byEvent = bindings.get(child.filePath) ?? bindings.set(child.filePath, new Map()).get(child.filePath)!;
        const list = byEvent.get(tagKey(event)) ?? byEvent.set(tagKey(event), []).get(tagKey(event))!;
        list.push({ parent, handler: el.handler!, child, event, angular, ...(angular ? {} : { bound: propFunctionName(el.component!, el.event, el.line) }) });
      }
    }

    /**
     * The functions an event of `file` reaches: each parent's named handler, and
     * where the parent only passes it on (`@save="(car) => $emit('save', car)"`),
     * the handlers its own parents bind to that event, up to four levels.
     */
    const targetsOf = (file: string, key: string, depth: number, seen: Set<string>): Array<{ file: string; span: SymbolSpan }> => {
      const at = `${file}#${key}`;
      if (depth > 4 || seen.has(at)) return [];
      seen.add(at);
      const out: Array<{ file: string; span: SymbolSpan }> = [];
      for (const b of bindings.get(file)?.get(key) ?? []) {
        const reEmit = (b.angular ? REEMIT_OUTPUT : REEMIT).exec(b.handler.trim());
        if (reEmit) {
          out.push(...targetsOf(b.parent.filePath, tagKey(reEmit[1]!), depth + 1, seen));
          continue;
        }
        // What an expression binding calls (`unitActions.deleteOne`): its markup function.
        const bound = b.bound ? spans(b.parent).find((sp) => sp.symbol === b.bound) : undefined;
        if (bound) {
          out.push({ file: b.parent.filePath, span: bound });
          continue;
        }
        const name = cleanHandler(b.handler);
        if (!name) continue; // inline expression, not a named handler
        const span = spans(b.parent).find((sp) => sp.symbol === name || sp.symbol.endsWith(`.${name}`));
        if (span) out.push({ file: b.parent.filePath, span });
      }
      return out;
    };

    const links: SymbolLink[] = [];
    const seenLink = new Set<string>();
    for (const [childFile, byEvent] of bindings) {
      const child = byPath.get(childFile)!;
      for (const [key, list] of byEvent) {
        // Declared or emitted in the child's script, or emitted straight from its markup (`@click="$emit('delete')"`).
        const markup = markupEmit(child, list[0]!.event);
        const sites = (child.events ?? []).filter((e) => tagKey(e.name) === key);
        if (sites.length === 0 && !markup) continue; // child never emits this event (native fallthrough)
        const targets = targetsOf(childFile, key, 0, new Set()).slice(0, 8);
        if (targets.length === 0) continue;
        // Spelled as the child emits it (`emit('cancelSelection')`), however the parent's tag writes it
        // (`@cancel-selection`): the report joins the child's element to this link by that spelling.
        const callName = `emit:${markup?.name ?? sites[0]!.name}`;
        // Anchor the child side at each function that emits it; a template-inline or
        // setup-level emit has no span — a synthetic `<template>` symbol keeps the edge
        // (the report joins by callName).
        const anchors = new Map<string, number>();
        for (const site of sites) {
          const fn = innermostAt(spans(child), site.line);
          if (fn && !anchors.has(fn.symbol)) anchors.set(fn.symbol, site.line);
        }
        if (anchors.size === 0) anchors.set("<template>", sites[0]?.line ?? markup!.line);
        for (const [symbol, line] of anchors) {
          for (const t of targets) {
            const k = `${symbol}\u0000${callName}\u0000${t.file}\u0000${t.span.symbol}`;
            if (seenLink.has(`${childFile}\u0000${k}`)) continue;
            seenLink.add(`${childFile}\u0000${k}`);
            links.push({
              sourceFile: childFile,
              sourceSymbol: symbol,
              sourceLine: line,
              callName,
              targetFile: t.file,
              targetSymbol: t.span.symbol,
              targetLine: t.span.line,
              confidence: "INFERRED",
            });
          }
        }
      }
    }
    // An output subscribed in code (`modal.componentInstance.confirmClicked.subscribe(() => …)`,
    // the dialog opened with that component): the subscribing function is the handler.
    for (const parent of analyses) {
      for (const sub of parent.componentSubscriptions ?? []) {
        const source = parent.imports.find((i) => i.specifiers.includes(sub.component))?.source;
        const childFile = source ? resolveTarget(source, parent.filePath, filePathMap) : null;
        const child = childFile ? byPath.get(childFile) : undefined;
        const target = child ? innermostAt(spans(parent), sub.line) : null;
        if (!child || !target) continue;
        // The output may be emitted by a base the dialog extends (`class TagEditDialog extends EditDialog`).
        let emitter: FileAnalysis | undefined = child;
        for (let depth = 0; emitter && depth < 3 && !(emitter.events ?? []).some((e) => e.name === sub.event); depth++) {
          const owner: FileAnalysis = emitter;
          const base = owner.classes.find((c) => c.name === sub.component || depth > 0)?.extends?.replace(/<.*$/s, "").trim();
          const from = base ? owner.imports.find((i) => i.specifiers.includes(base))?.source : undefined;
          const file = from ? resolveTarget(from, owner.filePath, filePathMap) : null;
          emitter = file ? byPath.get(file) : undefined;
        }
        if (!emitter) continue;
        for (const site of (emitter.events ?? []).filter((e) => e.name === sub.event)) {
          const fn = innermostAt(spans(emitter), site.line);
          const symbol = fn?.symbol ?? "<template>";
          const k = `${emitter.filePath}\u0000${symbol}\u0000emit:${sub.event}\u0000${parent.filePath}\u0000${target.symbol}`;
          if (seenLink.has(k)) continue;
          seenLink.add(k);
          links.push({
            sourceFile: emitter.filePath,
            sourceSymbol: symbol,
            sourceLine: site.line,
            callName: `emit:${sub.event}`,
            targetFile: parent.filePath,
            targetSymbol: target.symbol,
            targetLine: target.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}

/** A handler that only passes the event on: `$emit('save', car)`, `(car) => emit('save', car)`. */
const REEMIT = /^(?:(?:\([^()]*\)|[\w$]+)\s*=>\s*)?\$?emit\s*\(\s*['"]([\w:-]+)['"][^;]*\)$/;
/** Angular's: the parent emits an output of its own (`(reload)="reload.emit()"`, kept as `reload.emit`). */
const REEMIT_OUTPUT = /^(?:this\.)?([\w$]+)\.emit\b/;

/**
 * Angular components by the tag their selector gives them (`selector: 'app-cover-image'`)
 * → the declaring file. A selector two files declare is left out.
 */
function angularSelectors(analyses: FileAnalysis[]): Map<string, string> {
  const out = new Map<string, string>();
  const clash = new Set<string>();
  for (const a of analyses) {
    for (const cls of a.classes ?? []) {
      for (const d of cls.decorators ?? []) {
        const m = /^Component\s*\(\s*\{[\s\S]*?\bselector\s*:\s*['"`]([\w-]+)['"`]/.exec(d);
        if (!m) continue;
        const key = tagKey(m[1]!);
        if (out.has(key) && out.get(key) !== a.filePath) clash.add(key);
        out.set(key, a.filePath);
      }
    }
  }
  for (const k of clash) out.delete(k);
  return out;
}

/**
 * React's emit: a callback handed down as a prop. `<AddNewMovie
 * onMovieLookupChange={this.onMovieLookupChange} />` in the parent, and
 * `this.props.onMovieLookupChange(value)` (or a destructured `onMovieLookupChange()`,
 * or `onPress={onModalClose}` straight in the child's markup) in the child. The
 * child calls a name it never defines; the parent bound it on the child's tag.
 *
 * The join is the emit resolver's, by prop name instead of event: the parent's
 * element on the child's TAG binds prop `onX` to a handler → the tag's import
 * resolves to the child's file → the child references `onX`. A parent handler
 * that is itself a prop (drilled through) is followed up its own parents, up to
 * four levels. Only `on[A-Z]…` props — React's convention for callbacks, which
 * keeps data props out — and Vue props the parent's markup binds to an inline
 * function (`:add="(club) => create.mutateAsync(club)"`, extracted as its own
 * function by `markupFunctions`), which the child calls as `props.add(…)`. One link per child function calling the prop (callName
 * as written, so the report resolves `onPress={onModalClose}` through it), or
 * from `<template>` when only the markup uses it.
 */
export class JsPropCallbackResolver implements DispatchResolver {
  readonly id = "prop-callback";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 32;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    const globals = globalComponentFiles(analyses, filePathMap);
    const autoImported = autoImportedComponents(analyses);
    // child file → prop → bindings in parents.
    // `bound`: the function a Vue template's inline prop function is extracted as.
    const bindings = new Map<string, Map<string, Array<{ parent: FileAnalysis; handler: string; bound?: string }>>>();
    for (const parent of analyses) {
      const els = (parent.interactiveElements ?? []).filter(
        (el) => el.element === "custom" && el.component && el.handler && (PROP_CALLBACK.test(el.event) || VUE_PROP.test(el.event)),
      );
      if (els.length === 0) continue;
      const subByKey = new Map<string, string>([...(autoImported.get(parent.projectId ?? "") ?? []), ...globals]);
      for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) subByKey.set(tagKey(sub.name), sub.importSource);
      for (const el of els) {
        const src = subByKey.get(tagKey(el.component!));
        const childFile = src ? resolveTarget(src, parent.filePath, filePathMap) : null;
        if (!childFile || !byPath.has(childFile)) continue;
        const byProp = bindings.get(childFile) ?? bindings.set(childFile, new Map()).get(childFile)!;
        // Vue's `:update-permission="…"` is the child's `props.updatePermission`.
        const prop = VUE_PROP.test(el.event) ? camelProp(el.event.slice(1)) : el.event;
        const list = byProp.get(prop) ?? byProp.set(prop, []).get(prop)!;
        list.push({ parent, handler: el.handler!, ...(VUE_PROP.test(el.event) ? { bound: propFunctionName(el.component!, el.event, el.line) } : {}) });
      }
    }
    if (bindings.size === 0) return [];

    const spanCache = new Map<FileAnalysis, SymbolSpan[]>();
    const spans = (a: FileAnalysis) => spanCache.get(a) ?? spanCache.set(a, spansOf(a)).get(a)!;

    /** The functions a prop of `file` reaches: each parent's bound handler, through drilled props. */
    const targetsOf = (file: string, prop: string, depth: number, seen: Set<string>): Array<{ file: string; span: SymbolSpan }> => {
      const key = `${file}#${prop}`;
      if (depth > 4 || seen.has(key)) return [];
      seen.add(key);
      const out: Array<{ file: string; span: SymbolSpan }> = [];
      for (const b of bindings.get(file)?.get(prop) ?? []) {
        const inline = b.bound ? spans(b.parent).find((sp) => sp.symbol === b.bound) : undefined;
        if (inline) {
          out.push({ file: b.parent.filePath, span: inline });
          continue;
        }
        const name = cleanHandler(b.handler);
        if (!name) continue;
        const own = spans(b.parent).find((sp) => sp.symbol === name || sp.symbol.endsWith(`.${name}`));
        if (own) out.push({ file: b.parent.filePath, span: own });
        else if (PROP_CALLBACK.test(name)) out.push(...targetsOf(b.parent.filePath, name, depth + 1, seen));
      }
      return out.slice(0, 8);
    };

    const links: SymbolLink[] = [];
    for (const [childFile, byProp] of bindings) {
      const child = byPath.get(childFile)!;
      const defined = new Set(spans(child).map((sp) => sp.symbol.split(".").pop()!));
      for (const prop of byProp.keys()) {
        if (defined.has(prop)) continue; // the child's own function of that name
        const targets = targetsOf(childFile, prop, 0, new Set());
        if (targets.length === 0) continue;
        const callers: Array<{ symbol: string; line: number; callName: string }> = [];
        for (const fn of [...child.functions, ...child.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))]) {
          const call = fn.calls.find((c) => c.name === prop || c.name === `props.${prop}` || c.name === `this.props.${prop}`);
          if (call) callers.push({ symbol: fn.name, line: call.line, callName: call.name });
        }
        const inMarkup = (child.interactiveElements ?? []).find((el) => el.handler && cleanHandler(el.handler) === prop);
        if (callers.length === 0 && inMarkup) callers.push({ symbol: "<template>", line: inMarkup.line, callName: prop });
        for (const c of callers) {
          for (const t of targets) {
            links.push({
              sourceFile: childFile,
              sourceSymbol: c.symbol,
              sourceLine: c.line,
              callName: c.callName,
              targetFile: t.file,
              targetSymbol: t.span.symbol,
              targetLine: t.span.line,
              confidence: "INFERRED",
            });
          }
        }
      }
    }
    return links;
  }
}

/** React's callback-prop convention: `onPress`, `onModalClose`. */
const PROP_CALLBACK = /^on[A-Z]\w*$/;
/** A Vue prop bound to a function in markup (`:add="(club) => …"`, see `markupFunctions`). */
const VUE_PROP = /^:[a-zA-Z][\w-]*$/;

/** `update-permission` → `updatePermission`: how the child's script names a prop the template kebab-cases. */
function camelProp(prop: string): string {
  return prop.replace(/-([a-z\d])/g, (_, c: string) => c.toUpperCase());
}

interface SymbolSpan {
  symbol: string;
  line: number;
  endLine: number;
}

/** Case/kebab-insensitive tag identity: MyButton ≡ my-button; itemClick ≡ item-click. */
export function tagKey(name: string): string {
  return name.toLowerCase().replace(/-/g, "");
}

/** "onSave", "onSave(item)", "void onSave()" → "onSave"; inline expressions → null. */
function cleanHandler(handler: string): string | null {
  const clean = handler.replace(/\(.*$/, "").replace(/^(?:void|await|return)\s+|^!/, "").trim();
  if (!clean || !/^[\w.$]+$/.test(clean)) return null;
  return clean.split(".").pop()!;
}

function spansOf(a: FileAnalysis): SymbolSpan[] {
  const spans: SymbolSpan[] = [];
  for (const fn of a.functions ?? []) spans.push({ symbol: fn.name, line: fn.line, endLine: fn.endLine });
  for (const cls of a.classes ?? []) {
    for (const m of cls.methods ?? []) {
      spans.push({ symbol: `${cls.name}.${m.name}`, line: m.line, endLine: m.endLine });
    }
  }
  return spans;
}

function innermostAt(spans: SymbolSpan[], line: number): SymbolSpan | null {
  let best: SymbolSpan | null = null;
  let bestSpan = Infinity;
  for (const s of spans) {
    if (line >= s.line && line <= s.endLine && s.endLine - s.line < bestSpan) {
      bestSpan = s.endLine - s.line;
      best = s;
    }
  }
  return best;
}

/**
 * Components registered app-wide (`app.component("ClubCard", ClubCard)`), by tag key → the component's
 * file. A name two registrations give different files is left out.
 */
export function globalComponentFiles(analyses: FileAnalysis[], filePathMap: Map<string, string>): Map<string, string> {
  const out = new Map<string, string | null>();
  for (const a of analyses) {
    for (const sub of a.subComponents ?? []) {
      if (!sub.global || !sub.importSource) continue;
      const file = resolveTarget(sub.importSource, a.filePath, filePathMap);
      if (!file) continue;
      const key = tagKey(sub.name);
      out.set(key, out.has(key) && out.get(key) !== file ? null : file);
    }
  }
  return new Map([...out].filter((e): e is [string, string] => e[1] !== null));
}

/** An event the child's markup emits itself (`@click="$emit('delete', club.id)"`), at that element's line. */
function markupEmit(child: FileAnalysis, eventName: string): { name: string; line: number } | null {
  for (const el of child.interactiveElements ?? []) {
    for (const m of el.handler?.matchAll(/(?:^|[^\w$.])\$?emit\s*\(\s*['"]([\w:-]+)['"]/g) ?? []) {
      if (tagKey(m[1]!) === tagKey(eventName)) return { name: m[1]!, line: el.line };
    }
    // Angular: an output emitted from the markup (`(click)="read.emit(x)"`, kept as `read.emit`).
    const output = el.event.startsWith("(") ? /^(?:this\.)?([\w$]+)\.emit\b/.exec(el.handler ?? "") : null;
    if (output && tagKey(output[1]!) === tagKey(eventName)) return { name: output[1]!, line: el.line };
  }
  return null;
}

/** A Nuxt project's config file: its `components/` directories are imported by file name. */
const NUXT_CONFIG = /(?:^|\/)nuxt\.config\.[cm]?[jt]s$/;

/**
 * Components a Nuxt project imports without an import line, by tag key per
 * sub-project: each `.vue` file under a `components/` directory, by its file
 * name (`pathPrefix: false`) and by its path-prefixed name
 * (`components/club/ClubCard.vue` → `ClubCard`, `ClubClubCard` folded to
 * `ClubCard` as Nuxt does). A name two files claim is left out.
 */
export function autoImportedComponents(analyses: FileAnalysis[]): Map<string, Map<string, string>> {
  const nuxt = new Set(analyses.filter((a) => NUXT_CONFIG.test(a.filePath)).map((a) => a.projectId ?? ""));
  const out = new Map<string, Map<string, string | null>>();
  if (nuxt.size === 0) return new Map();
  for (const a of analyses) {
    const project = a.projectId ?? "";
    const m = /(?:^|\/)components\/(.+)\.vue$/.exec(a.filePath);
    if (!m || !nuxt.has(project)) continue;
    const segs = m[1]!.split("/");
    const base = segs[segs.length - 1]!.replace(/^index$/, segs[segs.length - 2] ?? "index");
    // Nuxt drops a file name's leading words its folders already said.
    let prefixed = "";
    for (const seg of segs.slice(0, -1)) prefixed += seg.replace(/^\w/, (c) => c.toUpperCase());
    const own = tagKey(base);
    const full = tagKey(prefixed).length && own.startsWith(tagKey(prefixed)) ? own : tagKey(prefixed) + own;
    const keys = out.get(project) ?? out.set(project, new Map()).get(project)!;
    for (const key of new Set([own, full])) keys.set(key, keys.has(key) && keys.get(key) !== a.filePath ? null : a.filePath);
  }
  return new Map([...out].map(([p, keys]) => [p, new Map([...keys].filter((e): e is [string, string] => e[1] !== null))]));
}
