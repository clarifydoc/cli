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
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 30;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    const links: SymbolLink[] = [];

    for (const parent of analyses) {
      const bindings = (parent.interactiveElements ?? []).filter(
        (el) => el.element === "custom" && el.component && el.handler && el.event.startsWith("@"),
      );
      if (bindings.length === 0) continue;

      // Tag → child import source, tolerant of kebab-vs-Pascal (<ist-button> / IstButton).
      const subByKey = new Map<string, string>();
      for (const sub of parent.subComponents ?? []) {
        if (sub.importSource) subByKey.set(tagKey(sub.name), sub.importSource);
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

interface SymbolSpan {
  symbol: string;
  line: number;
  endLine: number;
}

/** Case/kebab-insensitive tag identity: IstButton ≡ ist-button; itemClick ≡ item-click. */
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
