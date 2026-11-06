import type { ClassInfo, FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { resolveTarget, buildFilePathMap } from "../../shared/link-scoring.js";
import { propFunctionName } from "./markup-calls.js";
import { WHOLE_SLOT_PROPS } from "./template-scopes.js";

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
    interface Binding { parent: FileAnalysis; handler: string; calls?: string[]; child: FileAnalysis; event: string; angular: boolean; bound?: string }
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
        list.push({ parent, handler: el.handler!, ...(el.calls ? { calls: el.calls } : {}), child, event, angular, ...(angular ? {} : { bound: propFunctionName(el.component!, el.event, el.line) }) });
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
        // Each event the binding passes on, wherever it spells it: `(car) => $emit('save', car)`,
        // `editing = false; $emit('cancel')`, `full ? $emit('reject') : $emit('swap')`.
        const handler = b.handler.trim();
        const passed = b.angular ? [REEMIT_OUTPUT.exec(handler)?.[1]].filter((e): e is string => !!e) : [...handler.matchAll(EMIT_ANYWHERE)].map((m) => m[1]!);
        for (const event of new Set(passed.map(tagKey))) out.push(...targetsOf(b.parent.filePath, event, depth + 1, seen));
        if (b.angular ? passed.length > 0 : REEMIT.test(handler)) continue;
        // What an expression binding calls (`unitActions.deleteOne`): its markup function.
        const bound = b.bound ? spans(b.parent).find((sp) => sp.symbol === b.bound) : undefined;
        if (bound) {
          out.push({ file: b.parent.filePath, span: bound });
          continue;
        }
        // The named handler, and each further method a compound one calls (`page.set($event); reload()`).
        for (const handler of [b.handler, ...(b.calls ?? [])]) {
          const name = cleanHandler(handler);
          if (!name) continue; // inline expression, not a named handler
          const span = spans(b.parent).find((sp) => sp.symbol === name || sp.symbol.endsWith(`.${name}`));
          if (span) out.push({ file: b.parent.filePath, span });
          // An Angular output bound to a method of a typed field (`(dismissed)="transferStore.dismiss"`).
          else if (b.angular) {
            const target = fieldMethod(b.parent, handler, byPath, filePathMap);
            if (target) out.push({ file: target.file.filePath, span: target.span });
          }
        }
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
        // (the report joins by callName), also beside the functions emitting it elsewhere.
        const anchors = new Map<string, number>();
        for (const site of sites) {
          for (const line of site.sites ?? [site.line]) {
            const symbol = innermostAt(spans(child), line)?.symbol ?? (site.sites ? "<template>" : null);
            if (symbol && !anchors.has(symbol)) anchors.set(symbol, line);
          }
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
        if (sub.result) {
          // The dialog's own outcome: each method closing it through its active-dialog reference.
          for (const closer of dialogClosers(child, sub.component, sub.result, byPath, filePathMap)) {
            const k = `${closer.file}\u0000${closer.symbol}\u0000${closer.callName}\u0000${parent.filePath}\u0000${target.symbol}`;
            if (seenLink.has(k)) continue;
            seenLink.add(k);
            links.push({
              sourceFile: closer.file,
              sourceSymbol: closer.symbol,
              sourceLine: closer.line,
              callName: closer.callName,
              targetFile: parent.filePath,
              targetSymbol: target.symbol,
              targetLine: target.line,
              confidence: "INFERRED",
            });
          }
          continue;
        }
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
        for (const line of (emitter.events ?? []).filter((e) => e.name === sub.event).flatMap((e) => e.sites ?? [e.line])) {
          const fn = innermostAt(spans(emitter), line);
          const symbol = fn?.symbol ?? "<template>";
          const k = `${emitter.filePath}\u0000${symbol}\u0000emit:${sub.event}\u0000${parent.filePath}\u0000${target.symbol}`;
          if (seenLink.has(k)) continue;
          seenLink.add(k);
          links.push({
            sourceFile: emitter.filePath,
            sourceSymbol: symbol,
            sourceLine: line,
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

/**
 * The reference an open dialog holds to itself, by type → the methods that close it
 * (`this.modal.close(result)`) and dismiss it. ng-bootstrap's modal and offcanvas, Material's dialog.
 */
const ACTIVE_DIALOG_REFS: Record<string, { close: string; dismiss?: string }> = {
  NgbActiveModal: { close: "close", dismiss: "dismiss" },
  NgbActiveOffcanvas: { close: "close", dismiss: "dismiss" },
  MatDialogRef: { close: "close" },
};

/**
 * The methods of the dialog class `component` (or a base it extends, three deep) that close it —
 * `result: "close"` — or dismiss it, through a field holding its active-dialog reference.
 */
function dialogClosers(
  file: FileAnalysis,
  component: string,
  result: "close" | "dismiss",
  byPath: Map<string, FileAnalysis>,
  filePathMap: Map<string, string>,
): Array<{ file: string; symbol: string; line: number; callName: string }> {
  const out: Array<{ file: string; symbol: string; line: number; callName: string }> = [];
  let owner: FileAnalysis | undefined = file;
  let name: string | undefined = component;
  for (let depth = 0; owner && name && depth < 3; depth++) {
    const cls: ClassInfo | undefined = owner.classes.find((c) => c.name === name);
    if (!cls) break;
    const verbs = new Set<string>();
    for (const p of cls.properties ?? []) {
      const ref = ACTIVE_DIALOG_REFS[(p.type ?? "").replace(/<.*$/s, "").trim()];
      const verb = ref?.[result];
      if (verb) verbs.add(`this.${p.name}.${verb}`);
    }
    for (const m of cls.methods ?? []) {
      const call = m.calls.find((c) => verbs.has(c.name));
      if (call) out.push({ file: owner.filePath, symbol: `${cls.name}.${m.name}`, line: call.line, callName: call.name });
    }
    if (out.length) break;
    const base: string | undefined = cls.extends?.replace(/<.*$/s, "").trim();
    const from: string | undefined = base ? owner.imports.find((i) => i.specifiers.includes(base))?.source : undefined;
    const next: string | null = from ? resolveTarget(from, owner.filePath, filePathMap) : null;
    owner = next ? byPath.get(next) : undefined;
    name = base;
  }
  return out;
}

/** A handler that only passes the event on: `$emit('save', car)`, `(car) => emit('save', car)`. */
const REEMIT = /^(?:(?:\([^()]*\)|[\w$]+)\s*=>\s*)?\$?emit\s*\(\s*['"]([\w:-]+)['"][^;]*\)$/;
/** Every `emit('x')` / `$emit('x')` a Vue binding spells. */
const EMIT_ANYWHERE = /(?:^|[^\w$.])\$?emit\s*\(\s*['"]([\w:-]+)['"]/g;
/** Angular's: the parent emits an output of its own (`(reload)="reload.emit()"`, kept as `reload.emit`). */
const REEMIT_OUTPUT = /^(?:this\.)?([\w$]+)\.emit\b/;

/**
 * Angular components by the tag their selector gives them (`selector: 'app-cover-image'`)
 * → the declaring file. A selector two files declare is left out.
 */
/** The selectors of the Angular components a file declares (`app-cover-image`). */
export function angularSelectorsOf(a: FileAnalysis): string[] {
  const out: string[] = [];
  for (const cls of a.classes ?? []) {
    for (const d of cls.decorators ?? []) {
      const m = /^Component\s*\(\s*\{[\s\S]*?\bselector\s*:\s*['"`]([\w-]+)['"`]/.exec(d);
      if (m) out.push(m[1]!);
    }
  }
  return out;
}

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
 * function by `markupFunctions`), which the child calls as `props.add(…)`, or to one of
 * its own functions by name (`:on-confirm="confirmDeletion"`, `FileAnalysis.functionProps`),
 * and Vue listeners (`@refresh="reload"`), which reach a child declaring `onRefresh` as a
 * prop as that prop. An options-API child calls it as `this.onSubmit(…)`. One link per child function calling the prop (callName
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
        (el) => el.element === "custom" && el.component && el.handler && (PROP_CALLBACK.test(el.event) || VUE_PROP.test(el.event) || VUE_LISTENER.test(el.event)),
      );
      if (els.length === 0 && !parent.functionProps?.length) continue;
      const subByKey = new Map<string, string>([...(autoImported.get(parent.projectId ?? "") ?? []), ...globals]);
      for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) subByKey.set(tagKey(sub.name), sub.importSource);
      const bind = (component: string, prop: string, handler: string, bound?: string, importSource?: string) => {
        const src = importSource ?? subByKey.get(tagKey(component));
        const childFile = src ? resolveTarget(src, parent.filePath, filePathMap) : null;
        if (!childFile || !byPath.has(childFile)) return;
        const byProp = bindings.get(childFile) ?? bindings.set(childFile, new Map()).get(childFile)!;
        const list = byProp.get(prop) ?? byProp.set(prop, []).get(prop)!;
        list.push({ parent, handler, ...(bound ? { bound } : {}) });
      };
      for (const el of els) {
        const bound = propFunctionName(el.component!, el.event, el.line);
        // Vue's `:update-permission="…"` is the child's `props.updatePermission`; a listener
        // `@refresh="reload"` reaches a child declaring `onRefresh` as a prop as that prop.
        if (VUE_PROP.test(el.event)) bind(el.component!, camelProp(el.event.slice(1)), el.handler!, bound);
        else if (VUE_LISTENER.test(el.event)) bind(el.component!, listenerProp(el.event), el.handler!, bound);
        else bind(el.component!, el.event, el.handler!);
      }
      // `:on-confirm="confirmDeletion"`: one of the parent's functions handed down by name.
      for (const fp of parent.functionProps ?? []) bind(fp.component, fp.prop, fp.handler, undefined, fp.importSource);
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
          // `this.onSubmit(…)`: an options-API component calls its prop through `this` (its own method of that name is `defined`).
          // Invoked, never a value read or handed on (`return this.isNote`).
          const call = fn.calls.find((c) => !c.passed && !c.read && (c.name === prop || c.name === `props.${prop}` || c.name === `this.props.${prop}` || c.name === `this.${prop}`));
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

/**
 * A scoped slot's function: the component offers `<slot :save="saveAll" />`, its parent's
 * `<template #default="{ save }"> <button @click="save(club)">` calls it. The parent's slot
 * template sits inside the child's tag, so the tag names the file; the slot and prop name the
 * function (`FileAnalysis.slotFunctions`, the parent's `InteractiveElementInfo.scope`). One link
 * per element, from the parent's `<setup>` (where the template's calls live), by the name as
 * the markup spells it.
 */
export class JsSlotScopeResolver implements DispatchResolver {
  readonly id = "slot-scope";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 34;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    if (!analyses.some((a) => a.slotFunctions?.length)) return [];
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    const globals = globalComponentFiles(analyses, filePathMap);
    const autoImported = autoImportedComponents(analyses);
    const links: SymbolLink[] = [];
    for (const parent of analyses) {
      const els = (parent.interactiveElements ?? []).filter((el) => el.scope?.some((s) => s.slot));
      if (els.length === 0) continue;
      const subByKey = new Map<string, string>([...(autoImported.get(parent.projectId ?? "") ?? []), ...globals]);
      for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) subByKey.set(tagKey(sub.name), sub.importSource);
      for (const el of els) {
        for (const s of el.scope!) {
          if (!s.slot) continue;
          const src = subByKey.get(tagKey(s.slot.component));
          const childFile = src ? resolveTarget(src, parent.filePath, filePathMap) : null;
          const child = childFile ? byPath.get(childFile) : undefined;
          if (!child) continue;
          // `#default="props"` binds every prop under one name: each `props.save` the handler reads is that prop.
          const members: Array<{ call: string; prop: string }> = s.slot.prop === WHOLE_SLOT_PROPS
            ? [...new Set([...(el.handler ?? "").replace(/\?\./g, ".").matchAll(new RegExp(`(?<![\\w$.])${s.name.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1]!))].map((prop) => ({ call: `${s.name}.${prop}`, prop }))
            : [{ call: s.name, prop: s.slot.prop }];
          for (const member of members) {
            const offered = (child.slotFunctions ?? []).filter((f) => f.slot === s.slot!.name && f.prop === member.prop);
            // Two outlets of one slot offering the prop different functions: no guess.
            if (new Set(offered.map((f) => f.handler)).size !== 1) continue;
            const name = offered[0]!.handler;
            const span = spansOf(child).find((sp) => sp.symbol === name || sp.symbol.endsWith(`.${name}`));
            if (!span) continue;
            links.push({
              sourceFile: parent.filePath,
              sourceSymbol: "<setup>",
              sourceLine: el.line,
              callName: member.call,
              targetFile: child.filePath,
              targetSymbol: span.symbol,
              targetLine: span.line,
              confidence: "INFERRED",
            });
          }
        }
      }
    }
    return links;
  }
}

/**
 * Vue's provide/inject of a function: `provide('transferPlayer', onTransferPlayer)` in
 * an ancestor, `const transferPlayer = inject('transferPlayer')` … `transferPlayer(p)` in a
 * component below it. Vue finds the key up the component tree at runtime; the join is
 * by the literal key (`FileAnalysis.contextValues`). One component providing the key in
 * the sub-project is the one; several, and only the nearest that renders the injecting
 * component (its tag in their markup, through up to six levels) is — none rendering it,
 * no link. One link per function calling the injected local (callName as written), or
 * from `<template>` when only the markup calls it.
 */
export class JsProvideInjectResolver implements DispatchResolver {
  readonly id = "provide-inject";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 33;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const injecting = analyses.filter((a) => a.contextValues?.some((v) => v.kind === "inject"));
    if (injecting.length === 0) return [];
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    // key → the providing files, and the function each hands on, per sub-project.
    const providers = new Map<string, Array<{ file: FileAnalysis; target: FileAnalysis; span: SymbolSpan }>>();
    for (const a of analyses) {
      for (const v of a.contextValues ?? []) {
        if (v.kind !== "provide") continue;
        const own = spansOf(a).find((sp) => sp.symbol === v.name || sp.symbol.endsWith(`.${v.name}`));
        const handed = own ? { target: a, span: own } : v.from && v.member ? factoryReturned(a, v.from, v.member, byPath, filePathMap) : null;
        if (!handed) continue;
        const k = `${a.projectId ?? ""}\u0000${v.key}`;
        (providers.get(k) ?? providers.set(k, []).get(k)!).push({ file: a, ...handed });
      }
    }
    if (providers.size === 0) return [];

    // child file → the files whose markup renders it.
    const globals = globalComponentFiles(analyses, filePathMap);
    const autoImported = autoImportedComponents(analyses);
    const parentsOf = new Map<string, Set<string>>();
    for (const parent of analyses) {
      if (!parent.subComponents?.length) continue;
      const auto = autoImported.get(parent.projectId ?? "");
      for (const sub of parent.subComponents) {
        const key = tagKey(sub.name);
        const src = sub.importSource && !sub.global ? sub.importSource : undefined;
        const child = src ? resolveTarget(src, parent.filePath, filePathMap) : globals.get(key) ?? auto?.get(key) ?? null;
        if (!child || child === parent.filePath) continue;
        (parentsOf.get(child) ?? parentsOf.set(child, new Set()).get(child)!).add(parent.filePath);
      }
    }

    /** The providers of `key` nearest above `file` in the render tree. */
    const nearestAbove = (file: string, candidates: Array<{ file: FileAnalysis; target: FileAnalysis; span: SymbolSpan }>) => {
      const seen = new Set([file]);
      let frontier = [file];
      for (let depth = 0; depth < 6 && frontier.length; depth++) {
        const next: string[] = [];
        for (const f of frontier) for (const p of parentsOf.get(f) ?? []) if (!seen.has(p)) (seen.add(p), next.push(p));
        const found = candidates.filter((c) => next.includes(c.file.filePath));
        if (found.length) return found;
        frontier = next;
      }
      return [];
    };

    const links: SymbolLink[] = [];
    for (const a of injecting) {
      for (const v of a.contextValues!) {
        if (v.kind !== "inject") continue;
        const candidates = (providers.get(`${a.projectId ?? ""}\u0000${v.key}`) ?? []).filter((c) => c.file !== a);
        const targets = candidates.length === 1 ? candidates : nearestAbove(a.filePath, candidates).slice(0, 4);
        if (targets.length === 0) continue;
        const callers: Array<{ symbol: string; line: number }> = [];
        for (const fn of [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))]) {
          const call = fn.calls.find((c) => c.name === v.name && !c.boundLocally);
          if (call) callers.push({ symbol: fn.name, line: call.line });
        }
        const inMarkup = (a.interactiveElements ?? []).find((el) => el.handler && cleanHandler(el.handler) === v.name);
        if (callers.length === 0 && inMarkup) callers.push({ symbol: "<template>", line: inMarkup.line });
        for (const c of callers) {
          for (const t of targets) {
            links.push({
              sourceFile: a.filePath,
              sourceSymbol: c.symbol,
              sourceLine: c.line,
              callName: v.name,
              targetFile: t.target.filePath,
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

/**
 * The function a factory hands back under `member` (`return { transfer: doTransfer }` in
 * `useSquadActions`), the factory being declared in `file` or imported into it by that name.
 */
function factoryReturned(
  file: FileAnalysis,
  factory: string,
  member: string,
  byPath: Map<string, FileAnalysis>,
  filePathMap: Map<string, string>,
): { target: FileAnalysis; span: SymbolSpan } | null {
  const source = file.functions.some((f) => f.name === factory) ? file.filePath : file.imports.find((i) => i.specifiers.includes(factory))?.source;
  const at = source === file.filePath ? file : source ? byPath.get(resolveTarget(source, file.filePath, filePathMap) ?? "") : undefined;
  const fn = at?.functions.find((f) => f.name === factory);
  const returned = fn?.calls.find((c) => c.passed === "return" && c.returnedAs === member && !c.name.includes("."));
  if (!at || !fn || !returned) return null;
  // The innermost function of that name the factory's body declares, else the module's.
  const named = spansOf(at).filter((sp) => sp.symbol === returned.name);
  const span = named.find((sp) => sp.line > fn.line && sp.endLine <= fn.endLine) ?? named[0];
  return span ? { target: at, span } : null;
}

/**
 * The method a `field.method` handler names on the class a component's field or constructor
 * parameter is typed with (`transferStore = inject(TransferStoreService)`), that class being
 * declared in the file or imported into it by name. An untyped field names nothing.
 */
function fieldMethod(
  parent: FileAnalysis,
  handler: string,
  byPath: Map<string, FileAnalysis>,
  filePathMap: Map<string, string>,
): { file: FileAnalysis; span: SymbolSpan } | null {
  const m = /^(?:this\.)?([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(handler.trim());
  if (!m) return null;
  const [, field, method] = m;
  let type: string | undefined;
  for (const cls of parent.classes ?? []) {
    type ??= cls.properties?.find((p) => p.name === field)?.type ?? cls.methods.find((x) => x.name === "constructor")?.params.find((p) => p.name === field)?.type ?? undefined;
  }
  const typeName = type && /^[A-Za-z_$][\w$]*$/.test(type) ? type : null;
  if (!typeName) return null;
  const source = parent.classes.some((c) => c.name === typeName) ? parent.filePath : parent.imports.find((i) => i.specifiers.includes(typeName))?.source;
  const file = source === parent.filePath ? parent : source ? byPath.get(resolveTarget(source, parent.filePath, filePathMap) ?? "") : undefined;
  const span = file ? spansOf(file).find((sp) => sp.symbol === `${typeName}.${method}`) : undefined;
  return file && span ? { file, span } : null;
}

/** React's callback-prop convention: `onPress`, `onModalClose`. */
const PROP_CALLBACK = /^on[A-Z]\w*$/;
/** A Vue prop bound to a function in markup (`:add="(club) => …"`, see `markupFunctions`). */
const VUE_PROP = /^:[a-zA-Z][\w-]*$/;

/** A Vue listener on a component's tag (`@refresh`, `@save-club.once`): a child may declare it as its `onRefresh` prop. */
const VUE_LISTENER = /^@[a-zA-Z][\w-]*(?:\.[\w-]+)*$/;

/** `@save-club.once` → `onSaveClub`: the prop Vue hands a listener to. */
function listenerProp(event: string): string {
  const name = camelProp(event.slice(1).split(".")[0]!);
  return `on${name[0]!.toUpperCase()}${name.slice(1)}`;
}

/** `update-permission` → `updatePermission`: how the child's script names a prop the template kebab-cases. */
function camelProp(prop: string): string {
  return prop.replace(/-([a-z\d])/g, (_, c: string) => c.toUpperCase());
}

export interface SymbolSpan {
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

export function spansOf(a: FileAnalysis): SymbolSpan[] {
  const spans: SymbolSpan[] = [];
  for (const fn of a.functions ?? []) spans.push({ symbol: fn.name, line: fn.line, endLine: fn.endLine });
  for (const cls of a.classes ?? []) {
    for (const m of cls.methods ?? []) {
      spans.push({ symbol: `${cls.name}.${m.name}`, line: m.line, endLine: m.endLine });
    }
  }
  return spans;
}

export function innermostAt(spans: SymbolSpan[], line: number): SymbolSpan | null {
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
