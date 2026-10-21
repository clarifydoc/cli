import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

/**
 * A Vue/Nuxt API client as real frontends write it: `const api = usePlayerApi()`
 * at the top of `<script setup>`, `usePlayerApi` imported through a barrel and
 * declared to return `PlayerApi` — a renamed re-export of `PlayerApiClient`,
 * while an unrelated class really named `PlayerApi` exists — and the call
 * `api.mealplans.createOne()` landing on a method `MealPlanAPI` inherits.
 */

const fn = (name: string, line: number, calls: CallInfo[] = [], extra: Record<string, unknown> = {}) =>
  ({ name, line, endLine: line + 4, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [], ...extra });
const call = (name: string, line: number, kind: CallInfo["kind"], target: string | null = null): CallInfo => ({ name, kind, target, line });
const klass = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, kind: "class", extends: null, implements: [], methods: [], properties: [], decorators: [], isExported: true, line: 1, endLine: 20, ...extra });
const prop = (name: string, type: string) => ({ name, type, visibility: "public", isStatic: false, isReadonly: false });
const imp = (source: string, specifiers: string[]) => ({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line: 1 });
const file = (filePath: string, o: { functions?: unknown[]; classes?: unknown[]; imports?: unknown[]; exports?: unknown[] }): FileAnalysis =>
  ({ filePath, language: "typescript", projectId: "root", imports: o.imports ?? [], exports: o.exports ?? [], functions: o.functions ?? [], classes: o.classes ?? [], routes: [], dataSources: [] }) as unknown as FileAnalysis;

function project(dialog: FileAnalysis): FileAnalysis[] {
  return [
    dialog,
    file("app/composables/api/index.ts", { exports: [{ name: "usePlayerApi", kind: "re-export", line: 1, source: "./api-client" }] }),
    file("app/composables/api/api-client.ts", {
      imports: [imp("app/lib/api", ["PlayerApi"])],
      functions: [fn("usePlayerApi", 3, [call("PlayerApi", 4, "cross-file", "app/lib/api")], { returnType: "PlayerApi" })],
      exports: [{ name: "usePlayerApi", kind: "variable", line: 3 }],
    }),
    file("app/lib/api/index.ts", { exports: [{ name: "PlayerApi", kind: "re-export", line: 1, source: "./client-player", sourceName: "PlayerApiClient" }] }),
    file("app/lib/api/client-player.ts", {
      imports: [imp("./player/mealplans", ["MealPlanAPI"])],
      classes: [klass("PlayerApiClient", { properties: [prop("mealplans", "MealPlanAPI")] })],
    }),
    // The players CRUD client: a class really named `PlayerApi`, which must not be taken for the alias.
    file("app/lib/api/player/players.ts", { classes: [klass("PlayerApi", { extends: "BaseCRUDAPI" })] }),
    file("app/lib/api/player/mealplans.ts", {
      imports: [imp("../base", ["BaseCRUDAPI"])],
      classes: [klass("MealPlanAPI", { extends: "BaseCRUDAPI" })],
    }),
    file("app/lib/api/base.ts", { classes: [klass("BaseCRUDAPI", { methods: [fn("createOne", 5)] })] }),
  ];
}

describe("module-scope receivers typed through an imported factory", () => {
  it("links a call on a <setup> local to the method its class inherits, through the renamed re-export", () => {
    const dialog = file("app/components/AddMeal.vue", {
      imports: [imp("app/composables/api", ["usePlayerApi"])],
      functions: [
        fn("<setup>", 1, [call("usePlayerApi", 2, "cross-file", "app/composables/api")], { endLine: 1, localTypes: [{ name: "api", type: "", from: "usePlayerApi()" }] }),
        fn("addRecipeToPlan", 10, [call("api.mealplans.createOne", 11, "cross-file", "app/composables/api")]),
      ],
    });
    const link = buildSymbolLinks(project(dialog)).find((l) => l.sourceSymbol === "addRecipeToPlan");
    expect(link).toMatchObject({ targetFile: "app/lib/api/base.ts", targetSymbol: "BaseCRUDAPI.createOne", viaType: "MealPlanAPI", viaTypeFile: "app/lib/api/player/mealplans.ts" });
  });

  it("does not reach a module local the function shadows with a parameter", () => {
    const dialog = file("app/components/AddMeal.vue", {
      imports: [imp("app/composables/api", ["usePlayerApi"])],
      functions: [
        fn("<setup>", 1, [call("usePlayerApi", 2, "cross-file", "app/composables/api")], { endLine: 1, localTypes: [{ name: "api", type: "", from: "usePlayerApi()" }] }),
        fn("addRecipeToPlan", 10, [call("api.mealplans.createOne", 11, "cross-file", "app/composables/api")], { params: [{ name: "api", type: null, defaultValue: null }] }),
      ],
    });
    const link = buildSymbolLinks(project(dialog)).find((l) => l.sourceSymbol === "addRecipeToPlan");
    expect(link?.targetSymbol).not.toBe("BaseCRUDAPI.createOne");
  });
});
