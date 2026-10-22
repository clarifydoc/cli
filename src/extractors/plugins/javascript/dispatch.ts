import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { resolveTarget, buildFilePathMap } from "../../shared/link-scoring.js";

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
    const links: SymbolLink[] = [];
    const globals = globalComponentFiles(analyses, filePathMap);

    for (const parent of analyses) {
      const bindings = (parent.interactiveElements ?? []).filter(
        (el) => el.element === "custom" && el.component && el.handler && el.event.startsWith("@"),
      );
      if (bindings.length === 0) continue;

      // Tag → child import source, tolerant of kebab-vs-Pascal (<my-button> / MyButton);
      // a tag the file does not import is the component registered app-wide under that name.
      const subByKey = new Map<string, string>();
      for (const [k, file] of globals) subByKey.set(k, file);
      for (const sub of parent.subComponents ?? []) {
        if (sub.importSource && !sub.global) subByKey.set(tagKey(sub.name), sub.importSource);
      }
      if (subByKey.size === 0) continue;

      let parentSpans: SymbolSpan[] | null = null;

      for (const el of bindings) {
        const handlerName = cleanHandler(el.handler!);
        if (!handlerName) continue; // inline expression, not a named handler
        const eventName = el.event.slice(1).split(".")[0]!; // strip @ + modifiers

        const importSource = subByKey.get(tagKey(el.component!));
        if (!importSource) continue;
        const childFile = resolveTarget(importSource, parent.filePath, filePathMap);
        const child = childFile ? byPath.get(childFile) : undefined;
        if (!child) continue; // external/library component — nothing to wire

        const declared = (child.events ?? []).find((e) => tagKey(e.name) === tagKey(eventName));
        if (!declared) continue; // child never emits this event (native fallthrough)

        parentSpans ??= spansOf(parent);
        const handler = parentSpans.find(
          (sp) => sp.symbol === handlerName || sp.symbol.endsWith(`.${handlerName}`),
        );
        if (!handler) continue;

        // Anchor the child side at the function containing the emit; a
        // template-inline or setup-level emit has no span — a synthetic
        // `<template>` symbol keeps the edge (the report joins by callName).
        const emitFn = innermostAt(spansOf(child), declared.line);
        links.push({
          sourceFile: child.filePath,
          sourceSymbol: emitFn?.symbol ?? "<template>",
          sourceLine: declared.line,
          callName: `emit:${eventName}`,
          targetFile: parent.filePath,
          targetSymbol: handler.symbol,
          targetLine: handler.line,
          confidence: "INFERRED",
        });
      }
    }
    return links;
  }
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
 * four levels. Only `on[A-Z]…` props: React's convention for callbacks, which
 * keeps data props out. One link per child function calling the prop (callName
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
    // child file → prop → bindings in parents.
    const bindings = new Map<string, Map<string, Array<{ parent: FileAnalysis; handler: string }>>>();
    for (const parent of analyses) {
      const els = (parent.interactiveElements ?? []).filter(
        (el) => el.element === "custom" && el.component && el.handler && PROP_CALLBACK.test(el.event),
      );
      if (els.length === 0) continue;
      const subByKey = new Map<string, string>(globals);
      for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) subByKey.set(tagKey(sub.name), sub.importSource);
      for (const el of els) {
        const src = subByKey.get(tagKey(el.component!));
        const childFile = src ? resolveTarget(src, parent.filePath, filePathMap) : null;
        if (!childFile || !byPath.has(childFile)) continue;
        const byProp = bindings.get(childFile) ?? bindings.set(childFile, new Map()).get(childFile)!;
        const list = byProp.get(el.event) ?? byProp.set(el.event, []).get(el.event)!;
        list.push({ parent, handler: el.handler! });
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

interface SymbolSpan {
  symbol: string;
  line: number;
  endLine: number;
}

/** Case/kebab-insensitive tag identity: MyButton ≡ my-button; itemClick ≡ item-click. */
function tagKey(name: string): string {
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
function globalComponentFiles(analyses: FileAnalysis[], filePathMap: Map<string, string>): Map<string, string> {
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
