import { describe, it, expect } from "vitest";
// Side-effect: the resolver builds file-path maps via link-scoring, whose
// plugin-aggregated data (extension strip regex, external prefixes) is pushed
// in by the registry.
import "../../registry.js";
import { JsComponentEmitResolver, JsProvideInjectResolver } from "./dispatch.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/**
 * Component-event dispatch: a child's emit('save') and the parent's
 * <Child @save="onSave"> have no name-resolvable edge — the resolver joins
 * them via tag + declared event, exactly (no name guessing).
 */

function fa(filePath: string, over: Partial<FileAnalysis> = {}): FileAnalysis {
  return {
    filePath,
    language: "typescript",
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    dataSources: [],
    events: [],
    interactiveElements: [],
    subComponents: [],
    ...over,
  } as unknown as FileAnalysis;
}

const fn = (name: string, line: number, endLine: number) =>
  ({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine });

const parent = fa("src/pages/Cars.vue", {
  functions: [fn("onSave", 20, 30)],
  interactiveElements: [
    { element: "custom", event: "@save", handler: "onSave", line: 4, component: "SaveDialog" },
  ],
  subComponents: [{ name: "SaveDialog", importSource: "../components/SaveDialog.vue", props: [], line: 4 }],
});

const child = fa("src/components/SaveDialog.vue", {
  functions: [fn("confirm", 10, 15)],
  events: [{ name: "save", params: [], line: 12 }], // emit inside confirm()
});

describe("JsComponentEmitResolver", () => {
  it("wires the child's emit site to the parent's bound handler", () => {
    const [link] = new JsComponentEmitResolver().resolve([parent, child]);
    expect(link).toMatchObject({
      sourceFile: "src/components/SaveDialog.vue",
      sourceSymbol: "confirm",
      callName: "emit:save",
      targetFile: "src/pages/Cars.vue",
      targetSymbol: "onSave",
      confidence: "INFERRED",
    });
  });

  it("finds a child registered app-wide, whose tag the parent does not import (real-repo FP)", () => {
    const registry = fa("src/component/components.js", {
      subComponents: [{ name: "PClubDeleteDialog", importSource: "src/component/club/delete/dialog.vue", props: [], line: 5, global: true }],
      imports: [],
    });
    const dialog = fa("src/component/club/delete/dialog.vue", {
      functions: [fn("confirm", 10, 15)],
      events: [{ name: "confirm", params: [], line: 12 }],
    });
    const clipboard = fa("src/component/club/clipboard.vue", {
      functions: [fn("batchDelete", 40, 50)],
      interactiveElements: [{ element: "custom", event: "@confirm", handler: "batchDelete", line: 80, component: "PClubDeleteDialog" }],
      subComponents: [{ name: "PClubDeleteDialog", importSource: null, props: ["confirm"], line: 80 }],
    });
    const links = new JsComponentEmitResolver().resolve([registry, dialog, clipboard]);
    expect(links.map((l) => `${l.sourceFile}::${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`)).toEqual([
      "src/component/club/delete/dialog.vue::confirm -> src/component/club/clipboard.vue::batchDelete",
    ]);
  });

  it("matches kebab-case tags and event names to their camel forms", () => {
    const kebabParent = fa("src/pages/Cars.vue", {
      functions: [fn("onItemClick", 20, 30)],
      interactiveElements: [
        { element: "custom", event: "@item-click", handler: "onItemClick", line: 4, component: "save-dialog" },
      ],
      subComponents: [{ name: "SaveDialog", importSource: "../components/SaveDialog.vue", props: [], line: 4 }],
    });
    const camelChild = fa("src/components/SaveDialog.vue", {
      events: [{ name: "itemClick", params: [], line: 2 }],
    });
    const [link] = new JsComponentEmitResolver().resolve([kebabParent, camelChild]);
    expect(link?.targetSymbol).toBe("onItemClick");
    expect(link?.sourceSymbol).toBe("<template>"); // no containing fn at the emit line
    // Named as the child emits it, so the child's `emit('itemClick')` click finds the parent's handler.
    expect(link?.callName).toBe("emit:itemClick");
  });

  it("names the link as the child's markup emits it (real-repo FP)", () => {
    const kebabParent = fa("src/pages/Garage.vue", {
      functions: [fn("clearSelectedCar", 20, 30)],
      interactiveElements: [{ element: "custom", event: "@cancel-car-selection", handler: "clearSelectedCar", line: 4, component: "CarPicker" }],
      subComponents: [{ name: "CarPicker", importSource: "../components/CarPicker.vue", props: [], line: 4 }],
    });
    const child = fa("src/components/CarPicker.vue", {
      events: [{ name: "cancelCarSelection", params: [], line: 3 }],
      interactiveElements: [{ element: "button", event: "@click", handler: "emit('cancelCarSelection')", line: 12 }],
    });
    const [link] = new JsComponentEmitResolver().resolve([kebabParent, child]);
    expect(link).toMatchObject({ callName: "emit:cancelCarSelection", targetSymbol: "clearSelectedCar" });
  });

  it("follows a parent that only passes the event on to its own parent's handler, from each function emitting it (real-repo FP)", () => {
    const page = fa("src/pages/Garage.vue", {
      functions: [fn("createCar", 20, 30)],
      interactiveElements: [{ element: "custom", event: "@create", handler: "createCar", line: 4, component: "CarEditor" }],
      subComponents: [{ name: "CarEditor", importSource: "../components/CarEditor.vue", props: [], line: 4 }],
    });
    const editor = fa("src/components/CarEditor.vue", {
      interactiveElements: [{ element: "custom", event: "@create", handler: "(data) => $emit('create', data)", line: 6, component: "CarDialog" }],
      subComponents: [{ name: "CarDialog", importSource: "./CarDialog.vue", props: [], line: 6 }],
      events: [{ name: "create", params: [], line: 6 }],
    });
    const dialog = fa("src/components/CarDialog.vue", {
      functions: [fn("handleSubmit", 40, 60)],
      // Declared, then emitted from handleSubmit.
      events: [{ name: "create", params: [], line: 3 }, { name: "create", params: [], line: 55 }],
    });
    const links = new JsComponentEmitResolver().resolve([page, editor, dialog]);
    expect(links.map((l) => `${l.sourceFile}:${l.sourceSymbol} ${l.callName} -> ${l.targetFile}:${l.targetSymbol}`).sort()).toEqual([
      "src/components/CarDialog.vue:handleSubmit emit:create -> src/pages/Garage.vue:createCar",
      "src/components/CarEditor.vue:<template> emit:create -> src/pages/Garage.vue:createCar",
    ]);
  });

  it("joins an Angular output to the handler a parent binds on the component's selector, through a re-emitting parent", () => {
    const card = fa("src/app/match-card.component.ts", {
      classes: [{ name: "MatchCardComponent", decorators: ["Component({ selector: 'app-match-card', templateUrl: './match-card.component.html' })"], methods: [], properties: [] }] as never,
      events: [{ name: "read", params: [], line: 5 }],
      interactiveElements: [{ element: "button", event: "(click)", handler: "read.emit", line: 2 }],
    });
    const list = fa("src/app/match-list.component.ts", {
      classes: [{ name: "MatchListComponent", decorators: ["Component({ selector: 'app-match-list' })"], methods: [], properties: [] }] as never,
      events: [{ name: "opened", params: [], line: 4 }],
      interactiveElements: [{ element: "custom", event: "(read)", handler: "opened.emit", line: 3, component: "app-match-card" }],
    });
    const page = fa("src/app/fixtures.component.ts", {
      classes: [{ name: "FixturesComponent", decorators: ["Component({ selector: 'app-fixtures' })"], methods: [fn("openMatch", 20, 30)], properties: [] }] as never,
      interactiveElements: [{ element: "custom", event: "(opened)", handler: "openMatch", line: 3, component: "app-match-list" }],
    });
    const links = new JsComponentEmitResolver().resolve([card, list, page]);
    expect(links.map((l) => `${l.sourceFile}:${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`).sort()).toEqual([
      "src/app/match-card.component.ts:<template> emit:read -> FixturesComponent.openMatch",
      "src/app/match-list.component.ts:<template> emit:opened -> FixturesComponent.openMatch",
    ]);
  });

  it("joins an Angular output to each method a compound binding calls (real-repo FP)", () => {
    const card = fa("src/app/fixture-pager.component.ts", {
      classes: [{ name: "FixturePagerComponent", decorators: ["Component({ selector: 'app-fixture-pager' })"], methods: [fn("next", 4, 8)], properties: [] }] as never,
      events: [{ name: "pageChange", params: [], line: 6 }],
    });
    // `(pageChange)="page.set($event); reloadFixtures()"`
    const page = fa("src/app/fixtures.component.ts", {
      classes: [{ name: "FixturesComponent", decorators: ["Component({ selector: 'app-fixtures' })"], methods: [fn("reloadFixtures", 20, 30)], properties: [] }] as never,
      interactiveElements: [{ element: "custom", event: "(pageChange)", handler: "page.set", calls: ["reloadFixtures"], line: 3, component: "app-fixture-pager" }],
    });
    const links = new JsComponentEmitResolver().resolve([card, page]);
    expect(links.map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`)).toEqual(["FixturePagerComponent.next emit:pageChange -> FixturesComponent.reloadFixtures"]);
  });

  it("creates nothing for events the child never declares (native fallthrough)", () => {
    const clickParent = fa("src/pages/Cars.vue", {
      functions: [fn("submit", 20, 30)],
      interactiveElements: [
        { element: "custom", event: "@click", handler: "submit", line: 4, component: "SaveDialog" },
      ],
      subComponents: [{ name: "SaveDialog", importSource: "../components/SaveDialog.vue", props: [], line: 4 }],
    });
    expect(new JsComponentEmitResolver().resolve([clickParent, child])).toHaveLength(0);
  });

  it("creates nothing for external/library components", () => {
    const extParent = fa("src/pages/Cars.vue", {
      functions: [fn("submit", 20, 30)],
      interactiveElements: [
        { element: "custom", event: "@click", handler: "submit", line: 4, component: "MyButton" },
      ],
      subComponents: [{ name: "MyButton", importSource: "@acme/ui-components-vue", props: [], line: 4 }],
    });
    expect(new JsComponentEmitResolver().resolve([extParent, child])).toHaveLength(0);
  });

  it("fans out to every parent binding the same child event", () => {
    const p2 = fa("src/pages/Archive.vue", {
      functions: [fn("onArchiveSave", 5, 9)],
      interactiveElements: [
        { element: "custom", event: "@save", handler: "onArchiveSave", line: 2, component: "SaveDialog" },
      ],
      subComponents: [{ name: "SaveDialog", importSource: "../components/SaveDialog.vue", props: [], line: 2 }],
    });
    const links = new JsComponentEmitResolver().resolve([parent, p2, child]);
    expect(links.map((l) => l.targetSymbol).sort()).toEqual(["onArchiveSave", "onSave"]);
  });
});

describe("JsPropCallbackResolver — React callback props", () => {
  it("links a child's prop call to the parent's bound handler, through a drilled prop", async () => {
    const { JsPropCallbackResolver } = await import("./dispatch.js");
    const call = (name: string, line: number) => ({ name, kind: "internal" as const, target: null, line });
    const grand = fa("src/AddMovie.js", {
      functions: [{ ...fn("AddMovie.onLookup", 10, 14) }],
      interactiveElements: [{ element: "custom", event: "onMovieLookupChange", handler: "this.onLookup", line: 20, component: "AddNewMovieConnector" }],
      subComponents: [{ name: "AddNewMovieConnector", importSource: "./AddNewMovieConnector", props: [], line: 20 }],
    });
    const connector = fa("src/AddNewMovieConnector.js", {
      // Drills the prop on: binds its own prop to the child's.
      interactiveElements: [{ element: "custom", event: "onMovieLookupChange", handler: "onMovieLookupChange", line: 8, component: "AddNewMovie" }],
      subComponents: [{ name: "AddNewMovie", importSource: "./AddNewMovie", props: [], line: 8 }],
    });
    const child = fa("src/AddNewMovie.js", {
      functions: [{ ...fn("AddNewMovie.onSearchInputChange", 3, 5), calls: [call("this.props.onMovieLookupChange", 4)] }],
      interactiveElements: [{ element: "custom", event: "onModalClose", handler: "onModalClose", line: 9, component: "Modal" }],
    });
    const links = new JsPropCallbackResolver().resolve([grand, connector, child]);
    expect(links.map((l) => `${l.sourceFile}::${l.sourceSymbol} -${l.callName}-> ${l.targetFile}::${l.targetSymbol}`)).toEqual([
      "src/AddNewMovieConnector.js::<template> -onMovieLookupChange-> src/AddMovie.js::AddMovie.onLookup",
      "src/AddNewMovie.js::AddNewMovie.onSearchInputChange -this.props.onMovieLookupChange-> src/AddMovie.js::AddMovie.onLookup",
    ]);
  });
});

describe("JsPropCallbackResolver — Vue function props", () => {
  it("links a child's props.x() call to the inline function the parent's markup binds (real-repo FP)", async () => {
    const { JsPropCallbackResolver } = await import("./dispatch.js");
    const { markupFunctions } = await import("./markup-calls.js");
    const { extractVueInteractiveElements } = await import("./interactive-elements.js");
    const template = `<template>
  <ClubShareList
    :club-id="clubId"
    :add="(clubId, player) => createShare.mutateAsync({clubId, name: player.name})"
    :update-role="(clubId, share, role) => updateShare.mutateAsync({clubId, role})"
    :ref="(el) => setListRef(el)"
  />
</template>`;
    const elements = extractVueInteractiveElements(template, template);
    expect(elements.map((e) => e.event)).toEqual([":add", ":update-role"]);
    const fns = markupFunctions(elements, "src/ClubSharing.vue");
    expect(fns.map((f) => `${f.name}: ${f.calls.map((c) => c.name).join(",")}`)).toEqual([
      "<ClubShareList:add@2>: createShare.mutateAsync",
      "<ClubShareList:update-role@2>: updateShare.mutateAsync",
    ]);
    const parent = fa("src/ClubSharing.vue", {
      functions: fns,
      interactiveElements: elements,
      subComponents: [{ name: "ClubShareList", importSource: "./ClubShareList.vue", props: [], line: 2 }],
    });
    const call = (name: string, line: number) => ({ name, kind: "internal" as const, target: null, line });
    const child = fa("src/ClubShareList.vue", {
      functions: [{ ...fn("addSelected", 10, 14), calls: [call("props.add", 12)] }, { ...fn("changeRole", 16, 20), calls: [call("props.updateRole", 18)] }],
    });
    const links = new JsPropCallbackResolver().resolve([parent, child]);
    expect(links.map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetSymbol}`).sort()).toEqual([
      "addSelected -props.add-> <ClubShareList:add@2>",
      "changeRole -props.updateRole-> <ClubShareList:update-role@2>",
    ]);
  });
});

describe("JsComponentEmitResolver — an emit bound to an expression", () => {
  it("joins the child's emit to what the parent's binding calls (real-repo FP)", async () => {
    const { markupFunctions, markupCalls } = await import("./markup-calls.js");
    const { extractVueInteractiveElements } = await import("./interactive-elements.js");
    const template = `<template>
  <ClubDataPage
    @delete-one="clubActions.deleteOne"
    @save="actions.updateOne($event)"
    @restore="(id) => actions.restoreOne(id)"
    @rename="onRename"
    @transfer="transferPlayer"
    @close="$emit('close')"
    @pick="picked = $event"
  />
</template>`;
    const elements = extractVueInteractiveElements(template, template);
    // `onRename` is the page's own function; `transferPlayer` is destructured from a composable.
    const declared = new Set(["onRename"]);
    const fns = markupFunctions(elements, "src/pages/clubs.vue", declared);
    expect(fns.map((f) => `${f.name}: ${f.calls.map((c) => c.name).join(",")}`)).toEqual([
      "<ClubDataPage@delete-one@2>: clubActions.deleteOne",
      "<ClubDataPage@save@2>: actions.updateOne",
      "<ClubDataPage@restore@2>: actions.restoreOne",
      "<ClubDataPage@transfer@2>: transferPlayer",
    ]);
    // The binding's calls live in its own function, not in <setup> as well.
    expect(markupCalls(elements, "src/pages/clubs.vue", declared).map((c) => c.name)).toEqual(["onRename"]);
    const page = fa("src/pages/clubs.vue", {
      functions: [...fns, fn("onRename", 20, 24)],
      interactiveElements: elements,
      subComponents: [{ name: "ClubDataPage", importSource: "../components/ClubDataPage.vue", props: [], line: 2 }],
    });
    const child = fa("src/components/ClubDataPage.vue", {
      functions: [fn("confirmDelete", 10, 14), fn("submit", 16, 20)],
      events: [
        { name: "deleteOne", params: [], line: 12 },
        { name: "save", params: [], line: 18 },
        { name: "restore", params: [], line: 19 },
        { name: "rename", params: [], line: 19 },
        { name: "pick", params: [], line: 19 },
        { name: "transfer", params: [], line: 19 },
      ],
    });
    const links = new JsComponentEmitResolver().resolve([page, child]);
    expect(links.map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetSymbol}`).sort()).toEqual([
      "confirmDelete -emit:deleteOne-> <ClubDataPage@delete-one@2>",
      "submit -emit:rename-> onRename",
      "submit -emit:restore-> <ClubDataPage@restore@2>",
      "submit -emit:save-> <ClubDataPage@save@2>",
      "submit -emit:transfer-> <ClubDataPage@transfer@2>",
    ]);
  });
});

describe("JsComponentEmitResolver — a compound binding", () => {
  it("joins the child's emit to every function a compound binding calls, and passes on an emit wherever the binding spells it (real-repo FP)", async () => {
    const { markupFunctions } = await import("./markup-calls.js");
    const { extractVueInteractiveElements } = await import("./interactive-elements.js");
    const template = `<template>
  <LineupForm
    @save="saveLineup(); closeDrawer()"
    @cancel="editing = false; $emit('cancel')"
    @swap="benchFull ? $emit('reject') : $emit('swap', $event)"
  />
</template>`;
    const elements = extractVueInteractiveElements(template, template);
    const declared = new Set(["saveLineup", "closeDrawer"]);
    const fns = markupFunctions(elements, "src/components/Lineup.vue", declared);
    // Two calls are not one bare handler: the binding is a function of its own, holding both.
    expect(fns.map((f) => `${f.name}: ${f.calls.map((c) => c.name).join(",")}`)).toEqual(["<LineupForm@save@2>: saveLineup,closeDrawer"]);
    const lineup = fa("src/components/Lineup.vue", {
      functions: [...fns, fn("saveLineup", 20, 24), fn("closeDrawer", 26, 28)],
      interactiveElements: elements,
      subComponents: [{ name: "LineupForm", importSource: "./LineupForm.vue", props: [], line: 2 }],
      events: [{ name: "cancel", params: [], line: 4 }, { name: "reject", params: [], line: 5 }, { name: "swap", params: [], line: 5 }],
    });
    const form = fa("src/components/LineupForm.vue", {
      functions: [fn("submit", 10, 14)],
      events: [{ name: "save", params: [], line: 12 }, { name: "cancel", params: [], line: 13 }, { name: "swap", params: [], line: 13 }],
    });
    const page = fa("src/pages/Match.vue", {
      functions: [fn("discardLineup", 20, 24), fn("rejectSwap", 26, 28), fn("makeSwap", 30, 32)],
      interactiveElements: [
        { element: "custom", event: "@cancel", handler: "discardLineup", line: 3, component: "Lineup" },
        { element: "custom", event: "@reject", handler: "rejectSwap", line: 3, component: "Lineup" },
        { element: "custom", event: "@swap", handler: "makeSwap", line: 3, component: "Lineup" },
      ],
      subComponents: [{ name: "Lineup", importSource: "../components/Lineup.vue", props: [], line: 3 }],
    });
    const links = new JsComponentEmitResolver().resolve([page, lineup, form]);
    expect(links.filter((l) => l.sourceFile === form.filePath).map((l) => `${l.callName} -> ${l.targetFile}:${l.targetSymbol}`).sort()).toEqual([
      "emit:cancel -> src/pages/Match.vue:discardLineup",
      "emit:save -> src/components/Lineup.vue:<LineupForm@save@2>",
      "emit:swap -> src/pages/Match.vue:makeSwap",
      "emit:swap -> src/pages/Match.vue:rejectSwap",
    ]);
  });
});

describe("component-emit through a Nuxt project's auto-imported components", () => {
  it("joins a tag the parent never imports to the component file of that name, and an emit made in the child's markup", () => {
    const config = fa("web/nuxt.config.ts", { projectId: "web" } as Partial<FileAnalysis>);
    const page = fa("web/app/pages/clubs.vue", {
      projectId: "web",
      functions: [fn("handleDelete", 20, 30)],
      interactiveElements: [{ element: "custom", event: "@delete-one", handler: "handleDelete", line: 4, component: "ClubDataPage" }],
      subComponents: [{ name: "ClubDataPage", importSource: null, props: [], line: 4 }],
    } as Partial<FileAnalysis>);
    const card = fa("web/app/components/Domain/Club/ClubDataPage.vue", {
      projectId: "web",
      // No defineEmits: the template emits it straight away.
      interactiveElements: [{ element: "button", event: "@click", handler: "$emit('deleteOne', club.id)", line: 9 }],
    } as Partial<FileAnalysis>);
    const links = new JsComponentEmitResolver().resolve([config, page, card]);
    expect(links.map((l) => `${l.sourceFile}:${l.callName} -> ${l.targetSymbol}`)).toEqual([
      "web/app/components/Domain/Club/ClubDataPage.vue:emit:deleteOne -> handleDelete",
    ]);
  });

  it("does not guess a component outside a Nuxt project", () => {
    const page = fa("web/app/pages/clubs.vue", {
      functions: [fn("handleDelete", 20, 30)],
      interactiveElements: [{ element: "custom", event: "@delete-one", handler: "handleDelete", line: 4, component: "ClubDataPage" }],
      subComponents: [{ name: "ClubDataPage", importSource: null, props: [], line: 4 }],
    });
    const card = fa("web/app/components/ClubDataPage.vue", { events: [{ name: "delete-one", params: [], line: 3 }] });
    expect(new JsComponentEmitResolver().resolve([page, card])).toEqual([]);
  });
});

describe("component outputs subscribed in code", () => {
  const cls = (name: string, methods: Array<[string, number, number]>, ext: string | null = null) =>
    ({ name, extends: ext, implements: [], decorators: [], properties: [], methods: methods.map(([m, a, b]) => fn(m, a, b)), isExported: true, line: 1, endLine: 99 });

  it("joins a dialog's emit — in the base it extends — to the function subscribing to it", () => {
    const base = fa("src/app/common/confirm-dialog.component.ts", {
      classes: [cls("ConfirmDialogComponent", [["confirm", 70, 75]])] as never,
      events: [{ name: "confirmClicked", params: [], line: 72 }],
    });
    const release = fa("src/app/squad/release-dialog.component.ts", {
      classes: [cls("ReleaseDialogComponent", [["ngOnInit", 10, 12]], "ConfirmDialogComponent")] as never,
      imports: [{ source: "../common/confirm-dialog.component", specifiers: ["ConfirmDialogComponent"], line: 1 }] as never,
    });
    const opener = fa("src/app/squad/squad.component.ts", {
      classes: [cls("SquadComponent", [["release", 20, 30], ["other", 31, 40]])] as never,
      imports: [{ source: "./release-dialog.component", specifiers: ["ReleaseDialogComponent"], line: 2 }] as never,
      componentSubscriptions: [{ component: "ReleaseDialogComponent", event: "confirmClicked", line: 24 }, { component: "ReleaseDialogComponent", event: "cancelled", line: 26 }],
    });
    const links = new JsComponentEmitResolver().resolve([base, release, opener]);
    expect(links.map((l) => [l.sourceFile, l.sourceSymbol, l.callName, l.targetFile, l.targetSymbol])).toEqual([
      ["src/app/common/confirm-dialog.component.ts", "ConfirmDialogComponent.confirm", "emit:confirmClicked", "src/app/squad/squad.component.ts", "SquadComponent.release"],
    ]);
  });
});

describe("an event several functions of the child emit", () => {
  it("links each emitting function to the parent's handler (real-repo FP)", () => {
    const page = fa("src/pages/Transfers.vue", {
      functions: [fn("createTransfer", 20, 30)],
      interactiveElements: [{ element: "custom", event: "@create-transfer", handler: "createTransfer", line: 4, component: "TransferForm" }],
      subComponents: [{ name: "TransferForm", importSource: "../components/TransferForm.vue", props: [], line: 4 }],
    });
    const form = fa("src/components/TransferForm.vue", {
      functions: [fn("handleSendMessage", 4, 6), fn("handleSendWireMessage", 8, 10)],
      events: [{ name: "createTransfer", params: [], line: 5, sites: [5, 9] }],
    });
    const links = new JsComponentEmitResolver().resolve([page, form]);
    expect(links.map((l) => `${l.sourceSymbol}:${l.sourceLine} ${l.callName} -> ${l.targetSymbol}`)).toEqual([
      "handleSendMessage:5 emit:createTransfer -> createTransfer",
      "handleSendWireMessage:9 emit:createTransfer -> createTransfer",
    ]);
  });

  it("keeps the setup-level site beside the functions emitting it (real-repo FP)", () => {
    const page = fa("src/pages/Fixtures.vue", {
      functions: [fn("onFocus", 20, 30)],
      interactiveElements: [{ element: "custom", event: "@update:focused", handler: "onFocus", line: 4, component: "FixtureGrid" }],
      subComponents: [{ name: "FixtureGrid", importSource: "../components/FixtureGrid.vue", props: [], line: 4 }],
    });
    // `onClickOutside(grid, () => emit('update:focused', null))` at line 12, outside any function.
    const grid = fa("src/components/FixtureGrid.vue", {
      functions: [fn("setFocus", 20, 24)],
      events: [{ name: "update:focused", params: [], line: 12, sites: [12, 22] }],
    });
    const links = new JsComponentEmitResolver().resolve([page, grid]);
    expect(links.map((l) => `${l.sourceSymbol}:${l.sourceLine} -> ${l.targetSymbol}`)).toEqual(["<template>:12 -> onFocus", "setFocus:22 -> onFocus"]);
  });
});

describe("JsProvideInjectResolver", () => {
  const withSetup = (over: Partial<FileAnalysis>) => over;
  const call = (name: string, line: number) => ({ name, kind: "internal" as const, target: null, line, column: 2 });
  const fnCalling = (name: string, line: number, endLine: number, calls: ReturnType<typeof call>[]) => ({ ...fn(name, line, endLine), calls });

  const item = (path: string) =>
    fa(path, withSetup({
      functions: [fnCalling("onTransfer", 40, 44, [call("transferPlayer", 42)])],
      contextValues: [{ kind: "inject", key: "transferPlayer", name: "transferPlayer", line: 5 }],
    }));

  it("joins a call of an injected function to the function an ancestor provides under that key (real-repo FP)", () => {
    const list = fa("src/components/SquadList.vue", {
      functions: [fn("onTransferPlayer", 60, 70)],
      contextValues: [{ kind: "provide", key: "transferPlayer", name: "onTransferPlayer", line: 90 }],
      subComponents: [{ name: "PlayerItem", importSource: "./PlayerItem.vue", props: [], line: 3 }],
    });
    const links = new JsProvideInjectResolver().resolve([list, item("src/components/PlayerItem.vue")]);
    expect(links.map((l) => [l.sourceFile, l.sourceSymbol, l.sourceLine, l.callName, l.targetFile, l.targetSymbol, l.confidence])).toEqual([
      ["src/components/PlayerItem.vue", "onTransfer", 42, "transferPlayer", "src/components/SquadList.vue", "onTransferPlayer", "INFERRED"],
    ]);
  });

  it("takes the nearest ancestor among several providers, and refuses when none renders the injecting component", () => {
    const list = fa("src/components/SquadList.vue", {
      functions: [fn("onTransferPlayer", 60, 70)],
      contextValues: [{ kind: "provide", key: "transferPlayer", name: "onTransferPlayer", line: 90 }],
      subComponents: [{ name: "PlayerRow", importSource: "./PlayerRow.vue", props: [], line: 3 }],
    });
    const row = fa("src/components/PlayerRow.vue", {
      subComponents: [{ name: "PlayerItem", importSource: "./PlayerItem.vue", props: [], line: 3 }],
    });
    const page = fa("src/pages/Club.vue", {
      functions: [fn("transfer", 10, 20)],
      contextValues: [{ kind: "provide", key: "transferPlayer", name: "transfer", line: 30 }],
      subComponents: [{ name: "SquadList", importSource: "../components/SquadList.vue", props: [], line: 3 }],
    });
    const other = fa("src/pages/Youth.vue", {
      functions: [fn("promote", 10, 20)],
      contextValues: [{ kind: "provide", key: "transferPlayer", name: "promote", line: 30 }],
    });
    const links = new JsProvideInjectResolver().resolve([page, list, row, other, item("src/components/PlayerItem.vue")]);
    expect(links.map((l) => `${l.targetFile}::${l.targetSymbol}`)).toEqual(["src/components/SquadList.vue::onTransferPlayer"]);

    // Two providers, neither above the injecting component: no guess.
    const loose = fa("src/components/Bench.vue", {
      functions: [fn("onTransferPlayer", 60, 70)],
      contextValues: [{ kind: "provide", key: "transferPlayer", name: "onTransferPlayer", line: 90 }],
    });
    expect(new JsProvideInjectResolver().resolve([loose, other, item("src/components/PlayerItem.vue")])).toEqual([]);
  });

  it("follows a provided function destructured from a factory to the function the factory returns under that key", () => {
    const actions = fa("src/composables/useSquadActions.js", {
      functions: [
        { ...fn("useSquadActions", 5, 60), calls: [{ name: "doTransfer", kind: "internal", target: null, line: 58, column: 4, passed: "return", returnedAs: "transfer" }] },
        fn("doTransfer", 10, 20),
      ] as never,
    });
    const list = fa("src/components/SquadList.vue", {
      imports: [{ source: "../composables/useSquadActions", specifiers: ["useSquadActions"], line: 2 }] as never,
      contextValues: [{ kind: "provide", key: "transferPlayer", name: "transferPlayer", line: 90, from: "useSquadActions", member: "transfer" }],
    });
    const links = new JsProvideInjectResolver().resolve([actions, list, item("src/components/PlayerItem.vue")]);
    expect(links.map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)).toEqual([
      "onTransfer transferPlayer -> src/composables/useSquadActions.js::doTransfer",
    ]);
  });

  it("links from the markup when only the template calls the injected function", () => {
    const list = fa("src/components/SquadList.vue", {
      functions: [fn("onTransferPlayer", 60, 70)],
      contextValues: [{ kind: "provide", key: "transferPlayer", name: "onTransferPlayer", line: 90 }],
    });
    const chip = fa("src/components/PlayerChip.vue", {
      interactiveElements: [{ element: "button", event: "@click", handler: "transferPlayer(player)", line: 4 }],
      contextValues: [{ kind: "inject", key: "transferPlayer", name: "transferPlayer", line: 12 }],
    });
    const links = new JsProvideInjectResolver().resolve([list, chip]);
    expect(links.map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`)).toEqual(["<template> transferPlayer -> onTransferPlayer"]);
  });
});

describe("a dialog closing itself runs the opener's result handler", () => {
  const cls = (name: string, methods: Array<[string, number, number, string[]]>, properties: Array<[string, string]> = []) => ({
    name, extends: null, implements: [], decorators: [], isExported: true, line: 1, endLine: 99,
    properties: properties.map(([n, type]) => ({ name: n, type, visibility: "private", isStatic: false, isReadonly: true, decorators: [] })),
    methods: methods.map(([m, a, b, calls]) => ({ ...fn(m, a, b), calls: calls.map((c, i) => ({ name: c, kind: "internal", target: null, line: a + 1 + i, column: 4 })) })),
  });

  it("joins the dialog's close() through its active-modal reference to the function handling `closed` (real-repo FP)", () => {
    const modal = fa("src/app/club/edit-club-modal.component.ts", {
      classes: [cls("EditClubModalComponent", [["save", 40, 50, ["this.clubService.save", "this.modal.close"]], ["cancel", 52, 55, ["this.modal.dismiss"]], ["reset", 60, 62, ["this.form.reset"]]], [["modal", "NgbActiveModal"]])] as never,
    });
    const opener = fa("src/app/club/club-detail.component.ts", {
      classes: [cls("ClubDetailComponent", [["openEdit", 20, 30, []], ["other", 31, 40, []]])] as never,
      imports: [{ source: "./edit-club-modal.component", specifiers: ["EditClubModalComponent"], line: 2 }] as never,
      componentSubscriptions: [
        { component: "EditClubModalComponent", event: "closed", line: 24, result: "close" },
        { component: "EditClubModalComponent", event: "dismissed", line: 33, result: "dismiss" },
      ],
    });
    const links = new JsComponentEmitResolver().resolve([modal, opener]);
    expect(links.map((l) => [l.sourceSymbol, l.sourceLine, l.callName, l.targetFile, l.targetSymbol])).toEqual([
      ["EditClubModalComponent.save", 42, "this.modal.close", "src/app/club/club-detail.component.ts", "ClubDetailComponent.openEdit"],
      ["EditClubModalComponent.cancel", 53, "this.modal.dismiss", "src/app/club/club-detail.component.ts", "ClubDetailComponent.other"],
    ]);
  });

  it("links nothing for a component that holds no active-dialog reference", () => {
    const card = fa("src/app/club/club-card.component.ts", {
      classes: [cls("ClubCardComponent", [["save", 40, 50, ["this.modal.close"]]], [["modal", "ModalShell"]])] as never,
    });
    const opener = fa("src/app/club/club-detail.component.ts", {
      classes: [cls("ClubDetailComponent", [["openEdit", 20, 30, []]])] as never,
      imports: [{ source: "./club-card.component", specifiers: ["ClubCardComponent"], line: 2 }] as never,
      componentSubscriptions: [{ component: "ClubCardComponent", event: "closed", line: 24, result: "close" }],
    });
    expect(new JsComponentEmitResolver().resolve([card, opener])).toEqual([]);
  });
});
