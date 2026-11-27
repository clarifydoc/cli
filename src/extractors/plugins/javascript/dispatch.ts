import { NUXT_CONFIG } from "./nuxt-auto-imports.js";
import type { ClassInfo, ComponentSubscription, FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { resolveTarget, buildFilePathMap } from "../../shared/link-scoring.js";
import { propFunctionName } from "./markup-calls.js";
import { WHOLE_SLOT_PROPS } from "./template-scopes.js";
import { dispatchMapHoldersOf, type MapHeld } from "./dispatch-map-props.js";
import { escapeRegex } from "../shared/path-utils.js";
import { destructuredArrayProps, destructuredProps, destructuredRest } from "../../shared/destructuring.js";

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

/**
 * Targets once each, in the order found: a handler two bindings reach is one target, with the binding sites of both.
 * Every binding is kept, however many parents bind the child: each link stands for one tag a parent wrote (times
 * each function of the child emitting the event), so their number is bounded by the source, and a walk entering the
 * child from one parent leaves it only through that parent's bindings (`viaUsage`, core's usage gate).
 */
function distinctTargets<T extends { file: string; span: { symbol: string; line?: number }; usage?: Usage[] }>(targets: T[]): T[] {
  const seen = new Map<string, T>();
  const out: T[] = [];
  for (const t of targets) {
    const k = `${t.file}\0${t.span.symbol}\0${t.span.line ?? ""}`;
    const prev = seen.get(k);
    if (!prev) {
      const own = t.usage ? { ...t, usage: [...t.usage] } : t;
      seen.set(k, own);
      out.push(own);
      continue;
    }
    // A target one path reaches without a binding site is open to every entry.
    if (!prev.usage || !t.usage) delete prev.usage;
    else for (const u of t.usage) if (!prev.usage.some((x) => x.file === u.file && x.line === u.line)) prev.usage.push(u);
  }
  return out;
}

/** Where a parent binds a child's event or callback: its file and the tag's line (`SymbolLink.viaUsage`). */
type Usage = { file: string; line: number };

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
    interface Binding { parent: FileAnalysis; handler: string; calls?: string[]; child: FileAnalysis; event: string; angular: boolean; bound?: string; tag?: string; line: number }
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
      // A `<component :is>` tag binds its events on each component it may render.
      const bindingEls: Array<(typeof els)[number] & { tag?: string }> = els.flatMap((el) => (el.componentCandidates ? el.componentCandidates.map((component) => ({ ...el, component, tag: el.component })) : [el]));
      for (const el of bindingEls) {
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
        list.push({ parent, handler: el.handler!, ...(el.calls ? { calls: el.calls } : {}), child, event, angular, ...(angular ? {} : { bound: propFunctionName(el.tag ?? el.component!, el.event, el.line) }), tag: el.tag ?? el.component, line: el.line });
      }
    }

    /**
     * The functions an event of `file` reaches: each parent's named handler, and
     * where the parent only passes it on (`@save="(car) => $emit('save', car)"`),
     * the handlers its own parents bind to that event, up to four levels. Each with the binding site on the
     * child's own tag (`usage`): a passed-on event returns to the parent that passed it.
     */
    const targetsOf = (file: string, key: string, depth: number, seen: Set<string>, only?: (b: Binding) => boolean, via?: Usage): Array<{ file: string; span: SymbolSpan; usage: Usage[] }> => {
      const at = `${file}#${key}`;
      if (depth > 4 || seen.has(at)) return [];
      seen.add(at);
      const out: Array<{ file: string; span: SymbolSpan; usage: Usage[] }> = [];
      for (const b of (bindings.get(file)?.get(key) ?? []).filter((x) => !only || only(x))) {
        const usage = [via ?? { file: b.parent.filePath, line: b.line }];
        // Each event the binding passes on, wherever it spells it: `(car) => $emit('save', car)`,
        // `editing = false; $emit('cancel')`, `full ? $emit('reject') : $emit('swap')`.
        const handler = b.handler.trim();
        const passed = b.angular ? [REEMIT_OUTPUT.exec(handler)?.[1]].filter((e): e is string => !!e) : [...handler.matchAll(EMIT_ANYWHERE)].map((m) => m[1]!);
        for (const event of new Set(passed.map(tagKey))) out.push(...targetsOf(b.parent.filePath, event, depth + 1, seen, undefined, usage[0]));
        if (b.angular ? passed.length > 0 : REEMIT.test(handler)) continue;
        // What an expression binding calls (`unitActions.deleteOne`): its markup function.
        const bound = b.bound ? spans(b.parent).find((sp) => sp.symbol === b.bound) : undefined;
        if (bound) {
          out.push({ file: b.parent.filePath, span: bound, usage });
          continue;
        }
        // The named handler, and each further method a compound one calls (`page.set($event); reload()`).
        for (const handler of [b.handler, ...(b.calls ?? [])]) {
          const name = cleanHandler(handler);
          if (!name) continue; // inline expression, not a named handler
          const span = spans(b.parent).find((sp) => sp.symbol === name || sp.symbol.endsWith(`.${name}`));
          if (span) out.push({ file: b.parent.filePath, span, usage });
          // An Angular output bound to a method of a typed field (`(dismissed)="transferStore.dismiss"`).
          else if (b.angular) {
            const target = fieldMethod(b.parent, handler, byPath, filePathMap);
            if (target) out.push({ file: target.file.filePath, span: target.span, usage });
          }
        }
      }
      return out;
    };

    // The events a parent states for the child on this tag: those its bindings on the tag give, else (no tag-level
    // reading: a destructured composable result, a prop passed through) every `event:` string of the file.
    const statesEvent = (b: Binding, key: string): boolean => {
      const own = b.tag ? Object.entries(b.parent.eventLiteralsByTag ?? {}).find(([t]) => tagKey(t) === tagKey(b.tag!))?.[1] : undefined;
      return (own ?? b.parent.eventLiterals ?? []).some((n) => tagKey(n) === key);
    };
    const links: SymbolLink[] = [];
    const seenLink = new Set<string>();
    for (const [childFile, byEvent] of bindings) {
      const child = byPath.get(childFile)!;
      for (const [key, list] of byEvent) {
        // Declared or emitted in the child's script, or emitted straight from its markup (`@click="$emit('delete')"`).
        // A child that declares its emits states which events it has: one it leaves out is a native listener.
        const declared = child.declaredEmits;
        if (declared && !declared.some((n) => tagKey(n) === key)) continue;
        const markup = markupEmit(child, list[0]!.event);
        const sites = (child.events ?? []).filter((e) => tagKey(e.name) === key);
        // A child that emits by data (`$emit(btn.event)`) emits the events a parent states for it (`event: 'delete'`).
        const dynamic = sites.length === 0 && !markup && child.dynamicEmits?.length ? child.dynamicEmits : undefined;
        if (sites.length === 0 && !markup && !dynamic) continue; // child never emits this event (native fallthrough)
        const targets = distinctTargets(targetsOf(childFile, key, 0, new Set(), dynamic ? (b) => statesEvent(b, key) : undefined));
        if (targets.length === 0) continue;
        // Spelled as the child emits it (`emit('cancelSelection')`), however the parent's tag writes it
        // (`@cancel-selection`): the report joins the child's element to this link by that spelling.
        // The child declares the event and each parent binds it to a handler directly: both sides state it.
        const stated = !dynamic && !!declared && list.every((x) => !REEMIT.test(x.handler.trim()) && [...x.handler.matchAll(EMIT_ANYWHERE)].length === 0);
        const callName = `emit:${markup?.name ?? sites[0]?.name ?? list[0]!.event}`;
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
        for (const line of dynamic ?? []) {
          const symbol = innermostAt(spans(child), line)?.symbol ?? "<template>";
          if (!anchors.has(symbol)) anchors.set(symbol, line);
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
              confidence: stated ? "EXTRACTED" : "INFERRED",
              ...(t.usage ? { viaUsage: t.usage } : {}),
            });
          }
        }
      }
    }
    // An output subscribed in code (`modal.componentInstance.confirmClicked.subscribe(() => …)`,
    // the dialog opened with that component): the subscribing function is the handler.
    for (const parent of analyses) {
      for (const sub0 of parent.componentSubscriptions ?? []) {
        // A dialog a field holds (`open(this.editClubDialog)`): each class the class or a subclass assigns it.
        const opened = sub0.component.startsWith("this.") ? fieldComponents(parent, sub0, analyses, filePathMap) : [{ name: sub0.component, owner: parent }];
        for (const { name: component, owner } of opened) {
          const sub = { ...sub0, component };
          const source = owner.imports.find((i) => i.specifiers.includes(sub.component))?.source;
          const childFile = source ? resolveTarget(source, owner.filePath, filePathMap) : null;
          const child = childFile ? byPath.get(childFile) : undefined;
          const target = child ? innermostAt(spans(parent), sub.line) : null;
          if (!child || !target) continue;
          if (sub.result) {
            // The dialog's own outcome: each method closing it through its active-dialog reference.
            for (const closer of dialogClosers(child, sub.component, sub.result, byPath, filePathMap, sub.takesResult)) {
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
                // The opener's subscription is the instance: a dialog two screens open closes back to its own opener.
                viaUsage: [{ file: parent.filePath, line: sub.line }],
              });
            }
            continue;
          }
          // The output may be emitted by a base the dialog extends (`class KitEditDialog extends EditDialog`).
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
              viaUsage: [{ file: parent.filePath, line: sub.line }],
            });
          }
        }
      }
    }
    // `useDialog("match", (v) => emit("save", v))`: the composable calls its parameter, which emits.
    // The function of the composable that calls the parameter stands where the emit would.
    for (const file of analyses) {
      for (const e of file.events ?? []) {
        const key = tagKey(e.name);
        if (!bindings.get(file.filePath)?.has(key)) continue;
        for (const line of e.sites ?? [e.line]) {
          const hand = file.functions
            .flatMap((f) => f.calls.filter((c) => c.kind === "cross-file" && c.target && c.line <= line && line - c.line <= 8).map((c) => ({ c, f })))
            .filter(({ c }) => c.args?.some((x) => /^=>(?:[\w$]+\.)?\$?emit$/.test(x)))
            .sort((x, y) => y.c.line - x.c.line)[0];
          if (!hand) continue;
          const index = hand.c.args!.findIndex((x) => /^=>(?:[\w$]+\.)?\$?emit$/.test(x));
          const targetFile = resolveTarget(hand.c.target!, file.filePath, filePathMap);
          const lib = targetFile ? byPath.get(targetFile) : undefined;
          const leaf = hand.c.name.split(".").pop()!;
          const owner = lib?.functions.filter((f) => f.name === leaf);
          const param = owner?.length === 1 ? owner[0]!.params[index]?.name : undefined;
          if (!lib || !param) continue;
          const own = owner![0]!;
          const callers = lib.functions.filter((f) => f.name !== "<setup>" && f.line >= own.line && f.endLine <= own.endLine && f.calls.some((c) => c.name === param && c.kind === "internal"));
          const targets = distinctTargets(targetsOf(file.filePath, key, 0, new Set()));
          // Per instance: the calls this file makes on the local holding that composable's result
          // (`const dialog = useDialog(…)` → `dialog.confirm()`), never the composable's function for every user of it.
          const locals = new Set(file.functions.flatMap((f) => (f.localTypes ?? []).filter((l) => !l.type && l.from?.replace(/\(.*$/s, "") === leaf).map((l) => l.name)));
          for (const f of callers) {
            const member = f.name.split(".").pop()!;
            for (const user of file.functions) {
              for (const at of user.calls) {
                const [head, ...rest] = at.name.split(".");
                if (!locals.has(head!) || rest.join(".") !== member) continue;
                for (const t of targets) {
                  const k = `${file.filePath}\u0000${user.name}\u0000${at.line}\u0000emit:${e.name}\u0000${t.file}\u0000${t.span.symbol}`;
                  if (seenLink.has(k)) continue;
                  seenLink.add(k);
                  links.push({ sourceFile: file.filePath, sourceSymbol: user.name, sourceLine: at.line, callName: at.name, targetFile: t.file, targetSymbol: t.span.symbol, targetLine: t.span.line, confidence: "INFERRED", ...(t.usage ? { viaUsage: t.usage } : {}) });
                }
              }
            }
          }
        }
      }
    }
    return links;
  }
}

/**
 * The component classes a field of the subscribing class holds (`open(this.editClubDialog)`): each class the
 * class itself or a class extending it assigns the field (`this.editClubDialog = ClubEditDialogComponent`,
 * a `passed: "property"` record under `this.editClubDialog`), with the file that names it.
 */
function fieldComponents(parent: FileAnalysis, sub: ComponentSubscription, analyses: FileAnalysis[], filePathMap: Map<string, string>): Array<{ name: string; owner: FileAnalysis }> {
  const cls = parent.classes.filter((c) => sub.line >= c.line && sub.line <= c.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
  if (!cls) return [];
  const out: Array<{ name: string; owner: FileAnalysis }> = [];
  const assigned = (file: FileAnalysis, c: ClassInfo) => {
    for (const m of c.methods) for (const call of m.calls) if (call.passed === "property" && call.returnedAs === sub.component && !out.some((o) => o.name === call.name && o.owner === file)) out.push({ name: call.name, owner: file });
  };
  assigned(parent, cls);
  for (const a of analyses) {
    for (const c of a.classes) {
      if (c.extends?.replace(/<.*$/s, "").trim() !== cls.name) continue;
      const from = a.imports.find((i) => i.specifiers.includes(cls.name))?.source;
      const declared = a === parent || (from ? resolveTarget(from, a.filePath, filePathMap) === parent.filePath : false);
      if (declared) assigned(a, c);
    }
  }
  return out;
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
  takesResult = false,
): Array<{ file: string; symbol: string; line: number; callName: string }> {
  const out: Array<{ file: string; symbol: string; line: number; callName: string }> = [];
  // A `close()` with no argument hands a result-reading callback nothing: a Cancel button.
  const needsResult = takesResult && result === "close";
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
      const call = m.calls.find((c) => verbs.has(c.name) && !(needsResult && c.argCount === 0));
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
 * A file rendering a child that dispatches back (`<ClubDialog />`, `<club-dialog>`) is a USER of it, whatever its import
 * looks like: core's usage gate (`SymbolLink.viaUsage`) lets a user lead out of the child only through the bindings that
 * user states, so a page rendering the dialog without binding its callback reaches no other page's handler. One
 * `(reference)` link per rendered child, `dispatch:renders`; a tag spreading props or listeners into the child
 * (`{...props}`, `v-bind="$attrs"`, `v-on="$listeners"`) states no binding it can be held to and is
 * `dispatch:renders-open`, which keeps taking every binding. Only children that can dispatch back are stated.
 */
export class JsComponentRenderResolver implements DispatchResolver {
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 31;
  /** `renders` for the tags binding nothing, `renders-open` for the ones spreading (the runner stamps `dispatch:<id>`). */
  readonly id: string;
  constructor(private readonly open = false) {
    this.id = open ? "renders-open" : "renders";
  }

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    const globals = globalComponentFiles(analyses, filePathMap);
    const autoImported = autoImportedComponents(analyses);
    // The children some tag binds an event or callback on: the only ones whose users the gate tells apart.
    const bound = new Set<string>();
    for (const parent of analyses) {
      const byTag = new Map<string, string>([...(autoImported.get(parent.projectId ?? "") ?? []), ...globals]);
      for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) byTag.set(tagKey(sub.name), sub.importSource);
      const tags = [
        ...(parent.interactiveElements ?? []).filter((el) => el.element === "custom" && el.component && el.handler && (PROP_CALLBACK.test(el.event) || VUE_PROP.test(el.event) || VUE_LISTENER.test(el.event) || el.event.startsWith("@"))).map((el) => el.componentCandidates ?? [el.component!]).flat(),
        ...(parent.functionProps ?? []).map((fp) => fp.component),
      ];
      for (const tag of tags) {
        const src = byTag.get(tagKey(tag));
        const file = src ? resolveTarget(src, parent.filePath, filePathMap) : null;
        if (file) bound.add(file.split("\u0000")[0]!);
      }
    }
    const dispatches = (c: FileAnalysis) => bound.has(c.filePath);
    const links: SymbolLink[] = [];
    for (const parent of analyses) {
      if (!parent.subComponents?.length) continue;
      const auto = autoImported.get(parent.projectId ?? "");
      for (const sub of parent.subComponents) {
        if (sub.global) continue;
        const key = tagKey(sub.name);
        const file = sub.importSource ? resolveTarget(sub.importSource, parent.filePath, filePathMap) : globals.get(key) ?? auto?.get(key) ?? null;
        const child = file ? byPath.get(file.split("\u0000")[0]!) : undefined;
        if (!child || child.filePath === parent.filePath || !dispatches(child)) continue;
        const stem = child.filePath.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
        const spans = spansOf(child);
        const span = spans.find((sp) => tagKey(sp.symbol) === tagKey(stem)) ?? spans.find((sp) => tagKey(sp.symbol) === tagKey(sub.name)) ?? spans[0];
        if (!span) continue;
        if (sub.props.includes("...spread") !== this.open) continue;
        links.push({
          sourceFile: parent.filePath,
          sourceSymbol: "(reference)",
          sourceLine: sub.line,
          callName: `render:${sub.name}`,
          targetFile: child.filePath,
          targetSymbol: span.symbol,
          targetLine: span.line,
          confidence: "EXTRACTED",
          relation: "reference",
        });
      }
    }
    return links;
  }
}

/**
 * React's emit: a callback handed down as a prop. `<AddNewTrophy
 * onTrophyLookupChange={this.onTrophyLookupChange} />` in the parent, and
 * `this.props.onTrophyLookupChange(value)` (or a destructured `onTrophyLookupChange()`,
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
 *
 * `dispatch:prop-callback`. A callback prop's handler is, in the parent that binds it, its own function, a mixin's, a
 * function of an imported dispatch map, the parent's own prop handed on (followed up to four components), or a
 * function destructured from a project factory's result (`const { handleRelease } = useSquadActions()`;
 * `onRelease={handleRelease}`): the parent's call of that name names the factory (`CallInfo.via`), its module and the
 * member a renamed local stands for, and the link lands on the function the factory returns under that member
 * (`returnedMembers`, kind `function`, declared inside the factory); a member returned as a value, or a factory no
 * module the call names declares, joins nothing. A hook stating no members that only reads a context (`useContext(Ctx)`)
 * hands back what the module's `<Ctx.Provider>` component holds (`contextMember`). A props interface's method signature
 * (`interface IProps { onSave(club: Club): void }`) is a type: it never makes the prop a function the child owns.
 *
 * A component taking `{ n, ...others }` calls the prop `table.nextPage` as `others.table.nextPage()`
 * (`destructuredRest`, the resolver's `restOf`); a destructuring parameter named by its pattern
 * (`{ table, onRemove: remove }`) gives the props it takes and the names it binds (`destructuredProps`,
 * `patternBindings` in shared/destructuring.ts). A Vue `<script setup>` template's bare callback prop
 * (`:on-confirm="saveClub"`, the child calling `props.onConfirm()`) also puts a `passed: "attribute"` call on the
 * page's `<setup>` (`vuePassedFunctionProps`) so the page links to `saveClub` as `passes` the way JSX's
 * `onConfirm={saveClub}` does — never a map/array member, an imported map or a script-mounted dialog
 * (`importSource`); an Options API page's methods already are the page's, so it invents no `<setup>`; the child's
 * prop call stays the resolver's, scoped by `viaUsage` to the page that binds it.
 *
 * Emits: `defineEmits`/`emits:`, read with `defineProps` into `FileAnalysis.declaredProps`/`declaredEmits`, make
 * component-emit → parent-handler EXTRACTED when the child declares the event and refused when it declares only
 * others; a parent's `@event` is a `listeners` entry, never a prop. A child emitting by data
 * (`FileAnalysis.dynamicEmits`, `$emit(btn.event)`) reaches the handlers a parent states with `event: 'name'`
 * literals (`eventLiterals`, taken from THAT child's tag — `eventLiteralsByTag`: the `event:` strings of its bindings
 * and of the script declarations they name, three deep; only a tag with none falls back to the file's) and
 * `<component :is="Map[k]">` fans out over the map's `componentCandidates` (dynamic-components.ts;
 * dynamic-emits.test.ts). Targets are deduplicated (one per handler, with each binding's sites) and never capped. A
 * callback handed to a composable whose one call is `emit` (`useDialog(x, (v) => emit('save', v))`, `onSave(v)`
 * inside) reaches the parent's handler from the calls the component makes on the local holding the composable's
 * result (`dialog.confirm()`), never from the composable's own function. A member destructured from a factory's
 * result and passed on bare (`const { actions } = useData(); useCrud(actions)`) is a `localTypes` entry marked
 * `destructured` that only the argument pass reads. Tests: callback-props.test.ts, prop-types.test.ts. A tag
 * spreading props or listeners (`{...props}`, `v-bind="$attrs"`, `v-on="$listeners"`) is `dispatch:renders-open`.
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
    // `site`: the file whose markup binds it, when `parent` is the module that declares the handed dispatch map.
    const bindings = new Map<string, Map<string, Array<{ parent: FileAnalysis; handler: string; bound?: string; creator?: string; handlerImport?: { source: string; name: string }; site?: string; line: number }>>>();
    /** The functions an imported dispatch map holds, from the module that declares it (re-exports followed). */
    const importedMap = (from: FileAnalysis, imp: { source: string; name: string }): { owner: FileAnalysis; held: MapHeld[] } | null => {
      // The walk is depth-bounded, which also ends a cycle of barrels.
      const walk = (source: string, importer: string, name: string, hop: number): { owner: FileAnalysis; held: MapHeld[] } | null => {
        const file = resolveTarget(source, importer, filePathMap);
        const owner = file && hop < 4 ? byPath.get(file.split("\u0000")[0]!) : undefined;
        if (!owner) return null;
        const held = dispatchMapHoldersOf([owner.functions.find((f) => f.name === "<setup>") ?? { calls: [] }], owner.imports).get(name);
        if (held) return { owner, held };
        // Re-exports: the named one first, then each `export *` (the map is in whichever declares it).
        const named = owner.exports.filter((e) => e.kind === "re-export" && e.source && e.name === name);
        for (const e of named.length > 0 ? named : owner.exports.filter((e) => e.kind === "re-export" && e.source && e.name === "*")) {
          const found = walk(e.source!, owner.filePath, e.sourceName && e.name === name ? e.sourceName : name, hop + 1);
          if (found) return found;
        }
        return null;
      };
      return walk(imp.source, from.filePath, imp.name, 0);
    };
    for (const parent of analyses) {
      const els = (parent.interactiveElements ?? []).filter(
        (el) => el.element === "custom" && el.component && el.handler && (PROP_CALLBACK.test(el.event) || VUE_PROP.test(el.event) || VUE_LISTENER.test(el.event)),
      );
      // A callback prop the parent hands down under ANOTHER name (`<FollowButton follow={this.props.onFollow} />`).
      const renamed = (parent.propBindings ?? []).filter((pb) => pb.origin.kind === "prop" && PROP_CALLBACK.test(pb.origin.name) && !PROP_CALLBACK.test(pb.prop));
      if (els.length === 0 && !parent.functionProps?.length && renamed.length === 0) continue;
      const subByKey = new Map<string, string>([...(autoImported.get(parent.projectId ?? "") ?? []), ...globals]);
      for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) subByKey.set(tagKey(sub.name), sub.importSource);
      const bind = (line: number, component: string, prop: string, handler: string, bound?: string, importSource?: string, creator?: string, handlerImport?: { source: string; name: string }, owner?: FileAnalysis) => {
        const src = importSource ?? subByKey.get(tagKey(component));
        let childFile = src ? resolveTarget(src, parent.filePath, filePathMap) : null;
        // A component the parent's own file declares (`const FollowButton = props => …`, beside its user): keyed by the pair.
        if (!childFile && !src && /^[A-Z]/.test(component) && spansOf(parent).some((sp) => sp.symbol === component)) childFile = `${parent.filePath}\u0000${component}`;
        if (!childFile || !byPath.has(childFile.split("\u0000")[0]!)) return;
        const byProp = bindings.get(childFile) ?? bindings.set(childFile, new Map()).get(childFile)!;
        const list = byProp.get(prop) ?? byProp.set(prop, []).get(prop)!;
        list.push({ parent: owner ?? parent, handler, ...(bound ? { bound } : {}), ...(creator ? { creator } : {}), ...(handlerImport ? { handlerImport } : {}), ...(owner ? { site: parent.filePath } : {}), line });
      };
      for (const el of els) {
        const bound = propFunctionName(el.component!, el.event, el.line);
        // Vue's `:update-permission="…"` is the child's `props.updatePermission`; a listener
        // `@refresh="reload"` reaches a child declaring `onRefresh` as a prop as that prop.
        // `:options="{ onClick: () => … }"` is extracted per member (`<ClubCard:options.onClick@8>`): the child's `props.options.onClick`.
        if (VUE_PROP.test(el.event)) bind(el.line, el.component!, el.event.slice(1).replace(/^[^.]+/, camelProp), el.handler!, bound);
        else if (VUE_LISTENER.test(el.event)) bind(el.line, el.component!, listenerProp(el.event), el.handler!, bound);
        else bind(el.line, el.component!, el.event, el.handler!);
      }
      // The handed-down prop is the parent's own prop: whatever the parent's callers bind to it, or the creator
      // `connect(…)` bound to that name, which the parent's call at the same line names (`mapDispatchToProps.onFollow`).
      for (const pb of renamed) {
        if (pb.origin.kind !== "prop") continue;
        const propName = pb.origin.name;
        const at = new Set<string>();
        for (const fn of [...parent.functions, ...parent.classes.flatMap((c) => c.methods)]) {
          if (pb.line < fn.line || pb.line > fn.endLine) continue;
          for (const c of fn.calls) if (c.line === pb.line && !c.passed && !c.read) at.add(c.name);
        }
        const creators = parent.functions.concat(parent.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))).filter((f) => at.has(f.name) && f.name.endsWith(`.${propName}`));
        bind(pb.line, pb.component, pb.prop, propName, undefined, undefined, creators.length === 1 ? creators[0]!.name : undefined);
      }
      // `:on-confirm="confirmDeletion"`: one of the parent's functions handed down by name.
      for (const fp of parent.functionProps ?? []) {
        // A dispatch map another module declares (`:actions="clubActions"`): one function prop per held function.
        const map = fp.mapImport ? importedMap(parent, fp.mapImport) : null;
        if (fp.mapImport) {
          for (const h of map?.held ?? []) bind(fp.line, fp.component, `${fp.prop}.${h.key}`, h.name, undefined, fp.importSource, undefined, h.handlerImport, map!.owner);
          continue;
        }
        bind(fp.line, fp.component, fp.prop, fp.handler, undefined, fp.importSource, undefined, fp.handlerImport);
      }
    }
    if (bindings.size === 0) return [];

    const spanCache = new Map<FileAnalysis, SymbolSpan[]>();
    const spans = (a: FileAnalysis) => spanCache.get(a) ?? spanCache.set(a, spansOf(a)).get(a)!;
    /** A name the parent leaves to a module its import puts in scope (a Vue mixin's method, `mixins: [stadiumActions]`): the ONE function of that name there. */
    const scopeMember = (parent: FileAnalysis, name: string): { file: string; span: SymbolSpan } | null => {
      const hits: Array<{ file: string; span: SymbolSpan }> = [];
      // A mixin may take on mixins of its own (`mixins: [baseActions]`): its imports put theirs in scope the same way, a few levels down.
      const visit = (from: FileAnalysis, depth: number, seen: Set<string>): void => {
        for (const imp of from.imports) {
          if (!imp.inScope || imp.inScope.names?.includes(name) === false) continue;
          const file = resolveTarget(imp.inScope.module, from.filePath, filePathMap);
          const lib = file ? byPath.get(file) : undefined;
          if (!lib || seen.has(lib.filePath)) continue;
          const span = spans(lib).find((sp) => sp.symbol === name);
          if (span) {
            if (!hits.some((h) => h.file === lib.filePath)) hits.push({ file: lib.filePath, span });
          } else if (depth < 3) visit(lib, depth + 1, new Set([...seen, lib.filePath]));
        }
      };
      visit(parent, 0, new Set([parent.filePath]));
      return hits.length === 1 ? hits[0]! : null;
    };

    /** The function a module the parent imports exports under `name`. */
    const importedExport = (parent: FileAnalysis, from: { source: string; name: string }): { file: string; span: SymbolSpan } | null => {
      const file = resolveTarget(from.source, parent.filePath, filePathMap);
      const lib = file ? byPath.get(file.split("\u0000")[0]!) : undefined;
      const span = lib ? spans(lib).find((sp) => sp.symbol === from.name) : undefined;
      return lib && span ? { file: lib.filePath, span } : null;
    };

    /**
     * A handler the parent destructured from a project factory's result (`const { handleRelease } = useSquadActions()`,
     * `onRelease={handleRelease}`): the function that factory returns under that member. Read off the parent's own call
     * of the name in the function holding the binding, which names the factory (`via`), its module (`target`) and the
     * member a renamed local stands for (`member`); only a factory member the factory states as a function joins.
     */
    const factoryMember = (parent: FileAnalysis, name: string, line: number): { file: string; span: SymbolSpan } | null => {
      const sources = new Map<string, { target: string; via: string; member: string }>();
      for (const fn of [...parent.functions, ...parent.classes.flatMap((c) => c.methods)]) {
        if (line < fn.line || line > fn.endLine) continue;
        for (const c of fn.calls) {
          if (c.name !== name || !c.via || !c.target) continue;
          const member = c.member ?? name;
          sources.set(`${c.target}\u0000${c.via}\u0000${member}`, { target: c.target, via: c.via, member });
        }
      }
      if (sources.size !== 1) return null;
      const { target, via, member } = [...sources.values()][0]!;
      // The module declaring the factory, through re-exports (a barrel), a few hops at most.
      const owner = (source: string, importer: string, factory: string, hop: number): { file: FileAnalysis; factory: FunctionInfo } | null => {
        const file = resolveTarget(source, importer, filePathMap);
        const lib = file && hop < 4 ? byPath.get(file.split("\u0000")[0]!) : undefined;
        if (!lib) return null;
        const fn = lib.functions.find((f) => f.name === factory);
        if (fn) return { file: lib, factory: fn };
        const named = lib.exports.filter((e) => e.kind === "re-export" && e.source && e.name === factory);
        for (const e of named.length > 0 ? named : lib.exports.filter((e) => e.kind === "re-export" && e.source && e.name === "*")) {
          const found = owner(e.source!, lib.filePath, e.sourceName && e.name === factory ? e.sourceName : factory, hop + 1);
          if (found) return found;
        }
        return null;
      };
      const found = owner(target, parent.filePath, via, 0);
      if (found && !found.factory.returnedMembers) return contextMember(found.file, found.factory, member);
      const returned = found?.factory.returnedMembers?.find((m) => m.key === member);
      if (!found || returned?.kind !== "function") return null;
      const local = returned.local ?? returned.key;
      // The function the factory returns: the one of that name inside the factory's own lines.
      const inside = spans(found.file).filter((sp) => sp.symbol === local && sp.line >= found.factory.line && sp.line <= found.factory.endLine);
      return inside.length === 1 ? { file: found.file.filePath, span: inside[0]! } : null;
    };

    /**
     * A handler destructured from a hook that reads a React context (`const useSquad = () => useContext(SquadContext)`,
     * `const { releasePlayer } = useSquad()`): the function of that name inside the provider component of the hook's
     * own module, the one rendering `<SquadContext.Provider value={…}>`. The hook states no object of its own, so the
     * context it reads names the provider; a module holding no such provider, two, or no function of that name in it
     * joins nothing (a namesake in another module's provider is never reached).
     */
    const contextMember = (file: FileAnalysis, hook: FunctionInfo, member: string): { file: string; span: SymbolSpan } | null => {
      if (hook.returnedFrom?.length !== 1 || !/^(?:React\.)?useContext\(\)$/.test(hook.returnedFrom[0]!)) return null;
      const reads = hook.calls.filter((c) => /^(?:React\.)?useContext$/.test(c.name) && c.args?.length === 1 && /^[A-Za-z_$][\w$]*$/.test(c.args[0]!));
      if (reads.length !== 1) return null;
      const tag = `${reads[0]!.args![0]}.Provider`;
      const providers = (file.subComponents ?? []).filter((sub) => sub.name === tag);
      if (providers.length !== 1) return null;
      const host = enclosingFunctions(file, providers[0]!.line)[0];
      if (!host) return null;
      const inside = spans(file).filter((sp) => sp.symbol === member && sp.line > host.line && sp.endLine <= host.endLine);
      return inside.length === 1 ? { file: file.filePath, span: inside[0]! } : null;
    };

    /** The functions a prop of `file` reaches: each parent's bound handler, through drilled props — with the binding site on the child's own tag. */
    const targetsOf = (file: string, prop: string, depth: number, seen: Set<string>, via?: Usage): Array<{ file: string; span: SymbolSpan; usage: Usage[] }> => {
      const key = `${file}#${prop}`;
      if (depth > 4 || seen.has(key)) return [];
      seen.add(key);
      const out: Array<{ file: string; span: SymbolSpan; usage: Usage[] }> = [];
      for (const b of bindings.get(file)?.get(prop) ?? []) {
        const usage = [via ?? { file: b.site ?? b.parent.filePath, line: b.line }];
        const inline = b.bound ? spans(b.parent).find((sp) => sp.symbol === b.bound) : undefined;
        if (inline) {
          out.push({ file: b.parent.filePath, span: inline, usage });
          continue;
        }
        const creator = b.creator ? spans(b.parent).find((sp) => sp.symbol === b.creator) : undefined;
        if (creator) {
          out.push({ file: b.parent.filePath, span: creator, usage });
          continue;
        }
        // A callback the script's options write in place is a function of its own (`<ConfirmBox:onConfirm@17>`).
        const held = b.handler.startsWith("<") ? spans(b.parent).find((sp) => sp.symbol === b.handler) : undefined;
        if (held) {
          out.push({ file: b.parent.filePath, span: held, usage });
          continue;
        }
        const name = cleanHandler(b.handler);
        if (!name) continue;
        const parentSignatures = signaturesOf(b.parent);
        const own = spans(b.parent).find((sp) => !parentSignatures.has(sp.symbol) && (sp.symbol === name || sp.symbol.endsWith(`.${name}`)));
        const fromMixin = own ? null : scopeMember(b.parent, name);
        // A function the file imports, held in a dispatch map it hands down (`{ save: saveClub }`).
        const imported = own || fromMixin || !b.handlerImport ? null : importedExport(b.parent, b.handlerImport);
        const returned = own || fromMixin || imported ? null : factoryMember(b.parent, name, b.line);
        if (own) out.push({ file: b.parent.filePath, span: own, usage });
        else if (imported) out.push({ file: imported.file, span: imported.span, usage });
        else if (fromMixin) out.push({ file: fromMixin.file, span: fromMixin.span, usage });
        else if (returned) out.push({ file: returned.file, span: returned.span, usage });
        // A prop of the parent handed on (`onConfirm={handleRelease}`, `handleRelease` the parent's own destructured prop),
        // under the name the parent takes it by (`{ onRelease: handleRelease }` hands on `onRelease`).
        else {
          const handed = propKeyOf(b.parent, name, b.line) ?? (PROP_CALLBACK.test(name) || takesProp(b.parent, name) ? name : null);
          if (handed) out.push(...targetsOf(b.parent.filePath, handed, depth + 1, seen, usage[0]));
        }
      }
      return distinctTargets(out);
    };

    const links: SymbolLink[] = [];
    for (const [childKey, byProp] of bindings) {
      const [childFile, localName] = childKey.split("\u0000") as [string, string | undefined];
      const child = byPath.get(childFile)!;
      // A component declared beside its user: only the calls inside its own body are the child's.
      const within = localName ? spans(child).find((sp) => sp.symbol === localName) : undefined;
      // A props interface's method signature (`interface IProps { onSubmit(f: Form): void }`) is a type, not a function the child owns.
      const signatures = signaturesOf(child);
      const defined = new Set(spans(child).filter((sp) => !signatures.has(sp.symbol)).map((sp) => sp.symbol.split(".").pop()!));
      for (const prop of byProp.keys()) {
        if (defined.has(prop)) continue; // the child's own function of that name
        const targets = targetsOf(childKey, prop, 0, new Set());
        if (targets.length === 0) continue;
        const head = prop.split(".")[0]!;
        const member = prop.slice(head.length);
        // A bare call of a prop no `on…` name marks is the prop's only where the component takes it
        // (`function KitRow({ order })`): elsewhere it is a function of the same name in scope. A component destructuring
        // it under another name calls it by that name (`{ onRemove: remove }` → `remove()`). A member of an object prop
        // (`table.nextPage`, a library object handed down) is the prop's when the component takes its head.
        const freeName = PROP_CALLBACK.test(prop) || childFile.endsWith(".vue") || !!child.declaredProps?.includes(head);
        // `pair={[archive, purge]}` is the props `pair.0` and `pair.1`: a component taking `{ pair: [first, second] }` calls `first()`.
        const slot = /^\.(\d+)(\.[\s\S]*)?$/.exec(member);
        const callsProp = (name: string, line: number): boolean => {
          if (slot) {
            const bound = arrayLocalOf(child, head, Number(slot[1]), line);
            return !!bound && name === bound + (slot[2] ?? "");
          }
          const local = propLocalOf(child, head, line);
          // `actions.map((a) => a.run())` over the prop: the element's member is the prop's `actions.run`.
          if (member && propElementsOf(child, local ? [local] : [`props.${head}`, `this.props.${head}`], line).some((e) => name === e + member)) return true;
          if (local !== undefined) return local !== null && name === local + member;
          // `function Pager({ n, ...others })`: `others.table.nextPage()` is the prop's `table.nextPage` — a rest holds every prop the pattern names no other way.
          const rest = restOf(child, line);
          if (rest && name.startsWith(`${rest}.`)) return name.slice(rest.length + 1) === prop;
          return name === prop && freeName;
        };
        const callers: Array<{ symbol: string; line: number; callName: string }> = [];
        for (const fn of [...child.functions, ...child.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))]) {
          if (within && (fn.line < within.line || fn.line > within.endLine)) continue;
          // `this.onSubmit(…)`: an options-API component calls its prop through `this` (its own method of that name is `defined`).
          // Invoked, never a value read or handed on (`return this.isHomeGame`). Each call site is one link (several pager buttons).
          const sites = new Set<number>();
          for (const c of fn.calls) {
            if (c.passed || c.read || sites.has(c.line)) continue;
            if (c.name !== `props.${prop}` && c.name !== `this.props.${prop}` && c.name !== `this.${prop}` && !callsProp(c.name, c.line)) continue;
            sites.add(c.line);
            callers.push({ symbol: fn.name, line: c.line, callName: c.name });
          }
        }
        // Markup's own handler (a template the script holds no call for): the prop's under the same rule —
        // a Svelte component's markup is its own.
        const inMarkup = (child.interactiveElements ?? []).find((el) => {
          if (!el.handler || (within && (el.line < within.line || el.line > within.endLine))) return false;
          const handler = cleanHandler(el.handler);
          if (!handler) return false;
          if (childFile.endsWith(".svelte")) return handler === prop;
          // `x.run()` in a loop `v-for="x in extra"` over the prop: its `extra.run`.
          if (member && el.scope?.some((sc) => sc.fromProp === head && el.handler!.replace(/\(.*$/s, "").trim() === `${sc.name}${member}`)) return true;
          const local = propLocalOf(child, head, el.line);
          if (local !== undefined) return !member && handler === local;
          // Markup names a prop of a component taking its props whole by the prop's name (`onClick={props.order}`).
          return handler === prop && (freeName || !destructuresProps(child, el.line));
        });
        if (callers.length === 0 && inMarkup) callers.push({ symbol: "<template>", line: inMarkup.line, callName: cleanHandler(inMarkup.handler!) ?? prop });
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
              viaUsage: t.usage,
            });
          }
        }
      }
    }
    return links;
  }
}

/** The body-less member signatures of the interfaces `file` declares (`IProps.onSave`): types, never functions a prop can run. */
function signaturesOf(file: FileAnalysis): Set<string> {
  return new Set(file.classes.filter((c) => c.kind === "interface").flatMap((c) => c.methods.map((m) => `${c.name}.${m.name}`)));
}

/** The element names of the callbacks around `line` that iterate one of `sources` (`FileAnalysis.propElements`). */
function propElementsOf(file: FileAnalysis, sources: readonly string[], line: number): string[] {
  return (file.propElements ?? []).filter((e) => e.line <= line && line <= e.endLine && sources.includes(e.source)).map((e) => e.local);
}

/**
 * Whether a component of `file` takes `name` as a prop under that name: a Vue component declaring it, a component
 * destructuring it from its props (`function KitRow({ order })`, `({ handleClose }: Props) =>`), or binding it on
 * onward as one (`propBindings` origin `prop`).
 */
function takesProp(file: FileAnalysis, name: string): boolean {
  if (file.declaredProps?.includes(name)) return true;
  if (file.propBindings?.some((pb) => pb.origin.kind === "prop" && pb.origin.name === name)) return true;
  return [...file.functions, ...file.classes.flatMap((c) => c.methods)].some((f) => destructuredProps(f.params[0]?.name ?? "").get(name) === name);
}

/** The functions of `file` around `line`, innermost first. */
function enclosingFunctions(file: FileAnalysis, line: number): FunctionInfo[] {
  return [...file.functions, ...file.classes.flatMap((c) => c.methods)]
    .filter((f) => line >= f.line && line <= f.endLine)
    .sort((a, b) => a.endLine - a.line - (b.endLine - b.line));
}

/**
 * The name a component around `line` binds its prop `prop` to by destructuring its first parameter
 * (`{ order }` → `order`, `{ onRemove: remove }` → `remove`, `{ onSave = noop }` → `onSave`); `null` when a nested
 * pattern takes it apart (`{ club: { id } }`), `undefined` when no such component takes it.
 */
function propLocalOf(file: FileAnalysis, prop: string, line: number): string | null | undefined {
  for (const f of enclosingFunctions(file, line)) {
    const props = destructuredProps(f.params[0]?.name ?? "");
    if (props.has(prop)) return props.get(prop)!;
  }
  return undefined;
}

/** The local the component around `line` binds the element `index` of its prop `prop` to by an array pattern (`{ pair: [first, second] }`), else null. */
function arrayLocalOf(file: FileAnalysis, prop: string, index: number, line: number): string | null {
  for (const f of enclosingFunctions(file, line)) {
    const bound = destructuredArrayProps(f.params[0]?.name ?? "").get(prop)?.[index];
    if (bound) return bound;
  }
  return null;
}

/** The name the component around `line` binds the props its pattern names no other way to (`function Pager({ n, ...others })` → `others`), else null. */
function restOf(file: FileAnalysis, line: number): string | null {
  for (const f of enclosingFunctions(file, line)) {
    const rest = destructuredRest(f.params[0]?.name ?? "");
    if (rest) return rest;
  }
  return null;
}

/** Whether the component around `line` destructures its props (`function KitRow({ order })`), rather than taking them whole. */
function destructuresProps(file: FileAnalysis, line: number): boolean {
  return enclosingFunctions(file, line).some((f) => f.params[0]?.name.trimStart().startsWith("{"));
}

/** The prop a component around `line` destructures into the local `local` (`{ onRelease: handleRelease }` → `onRelease`). */
function propKeyOf(file: FileAnalysis, local: string, line: number): string | null {
  for (const f of enclosingFunctions(file, line)) {
    for (const [prop, bound] of destructuredProps(f.params[0]?.name ?? "")) if (bound === local) return prop;
  }
  return null;
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
            ? [...new Set([...(el.handler ?? "").replace(/\?\./g, ".").matchAll(new RegExp(`(?<![\\w$.])${escapeRegex(s.name)}\\.([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1]!))].map((prop) => ({ call: `${s.name}.${prop}`, prop }))
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
 * An action item's callback: `<li v-for="item in items"><button @click="item.action()">` over a literal
 * array of objects the component declares (`{ label: 'Delete', action: this.remove }`). The loop variable's
 * member runs whichever item was clicked, so each function the array holds under that key is a candidate:
 * one INFERRED link per function, from the component's `<setup>`, by the name as the markup spells it.
 */
export class JsLoopItemCallbackResolver implements DispatchResolver {
  readonly id = "loop-item-callback";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 35;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const links: SymbolLink[] = [];
    for (const parent of analyses) {
      const els = (parent.interactiveElements ?? []).filter((el) => el.handler && el.scope?.some((s) => s.callbacks));
      if (els.length === 0) continue;
      const spans = spansOf(parent);
      const seen = new Set<string>();
      for (const el of els) {
        for (const s of el.scope!) {
          if (!s.callbacks) continue;
          const read = new RegExp(`(?<![\\w$.])${escapeRegex(s.name)}\\??\\.([A-Za-z_$][\\w$]*)`, "g");
          for (const m of el.handler!.matchAll(read)) {
            for (const fn of s.callbacks[m[1]!] ?? []) {
              // A callback written in place is named up to its line (`<items[].run@`): each of them.
              const found = fn.endsWith("@") ? spans.filter((sp) => sp.symbol.startsWith(fn)) : [spans.find((sp) => sp.symbol === fn || sp.symbol.endsWith(`.${fn}`))].filter((sp): sp is SymbolSpan => !!sp);
              for (const span of found) {
                const key = `${el.line}\0${s.name}.${m[1]}\0${span.symbol}`;
                if (seen.has(key)) continue;
                seen.add(key);
                links.push({
                  sourceFile: parent.filePath,
                  sourceSymbol: "<setup>",
                  sourceLine: el.line,
                  callName: `${s.name}.${m[1]}`,
                  targetFile: parent.filePath,
                  targetSymbol: span.symbol,
                  targetLine: span.line,
                  confidence: "INFERRED",
                });
              }
            }
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
const VUE_PROP = /^:[a-zA-Z][\w-]*(?:\.[A-Za-z_$][\w$]*)*$/;

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
  let byFile: Map<string, FileAnalysis> | null = null;
  for (const a of analyses) {
    for (const sub of a.subComponents ?? []) {
      if (!sub.global || !sub.importSource) continue;
      const file = resolveTarget(sub.importSource, a.filePath, filePathMap);
      if (!file) continue;
      // `Vue.component(c.name, c)`: the tag is the name the component declares itself; one declaring none is no tag.
      byFile ??= new Map(analyses.map((x) => [x.filePath, x]));
      const own = sub.registeredByName ? byFile.get(file.split("\u0000")[0]!)?.componentName : sub.name;
      if (!own) continue;
      const key = tagKey(own);
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
