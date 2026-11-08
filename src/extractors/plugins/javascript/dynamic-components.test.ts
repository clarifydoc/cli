import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: link-scoring data
import { createEmptyAnalysis, type FileAnalysis } from "../../../types/analysis.js";
import { addDynamicComponents } from "./dynamic-components.js";
import { JsComponentEmitResolver } from "./dispatch.js";

const TEMPLATE = `
  <component :is="FIELDS[kind]" @delete="removeField" />
  <component :is="Other" @delete="noop" />
`;
const SCRIPT = `
import TextField from '@/components/TextField.vue'
import DateField from '@/components/DateField.vue'
import Other from '@/components/Other.vue'
const FIELDS = { text: TextField, date: DateField }
`;
const RAW = `<template>${TEMPLATE}</template>\n<script setup>${SCRIPT}</script>`;

const imp = (source: string, name: string) => ({ source, specifiers: [name], isDefault: true, isNamespace: false, isType: false, line: 1 });
const fn = (name: string, line: number) => ({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine: line });

function parent(): FileAnalysis {
  return {
    ...createEmptyAnalysis("src/views/Fields.vue", "typescript"),
    imports: [imp("src/components/TextField.vue", "TextField"), imp("src/components/DateField.vue", "DateField"), imp("src/components/Other.vue", "Other")],
    functions: [fn("removeField", 30), fn("noop", 31)],
    interactiveElements: [
      { element: "custom", event: "@delete", handler: "removeField", line: 2, component: "component" },
      { element: "custom", event: "@delete", handler: "noop", line: 3, component: "component" },
    ],
  };
}
const child = (path: string) => ({ ...createEmptyAnalysis(path, "typescript"), events: [{ name: "delete", params: [], line: 4 }], functions: [fn("send", 3)] });

describe("a dynamic component tag", () => {
  it("binds its events on the components a literal map or a name states", () => {
    const a = parent();
    addDynamicComponents(a, TEMPLATE, RAW, SCRIPT);
    expect(a.interactiveElements.map((e) => e.componentCandidates)).toEqual([["TextField", "DateField"], ["Other"]]);
    expect(a.subComponents.map((s) => s.name)).toEqual(["TextField", "DateField", "Other"]);
  });

  it("reaches the parent's handler from each candidate's emit, and from no namesake that is not one", () => {
    const a = parent();
    addDynamicComponents(a, TEMPLATE, RAW, SCRIPT);
    const links = new JsComponentEmitResolver().resolve([a, child("src/components/TextField.vue"), child("src/components/DateField.vue"), child("src/components/DecoyField.vue")]);
    expect(links.map((l) => `${l.sourceFile} -> ${l.targetSymbol}`).sort()).toEqual([
      "src/components/DateField.vue -> removeField",
      "src/components/TextField.vue -> removeField",
    ]);
  });

  it("gives none when a map value is no imported name", () => {
    const a = parent();
    addDynamicComponents(a, TEMPLATE, RAW, SCRIPT.replace("date: DateField", "date: lazy(() => import('./x'))"));
    expect(a.interactiveElements[0]!.componentCandidates).toBeUndefined();
  });
});
