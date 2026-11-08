import { describe, it, expect } from "vitest";
import { extractEvents } from "./events.js";

describe("Vue component events", () => {
  it("read names with `:` and `-`, each placed where it is first emitted (real-repo FP)", () => {
    const src = `<script setup lang="ts">
const emit = defineEmits<{
  (e: 'update:fixture', fixture: Fixture): void
  (e: 'create-fixture', title: string): void
  (e: 'close'): void
}>()

async function saveFixture(f: Fixture) {
  emit('update:fixture', f)
}

function createFixture(title: string) {
  emit('create-fixture', title)
}
</script>`;
    expect(extractEvents(src, "typescript").map((e) => `${e.name} @${e.line}`)).toEqual([
      "update:fixture @9",
      "create-fixture @13",
      "close @5",
    ]);
  });
});

describe("Vue events one call signature declares together", () => {
  it("reads every name of a union (`e: 'create-one' | 'edit-one'`)", () => {
    const src = `const emit = defineEmits<{
  (e: "deleteOne", id: string): void;
  (e: "create-one" | "edit-one", data: Club): void;
}>();`;
    expect(extractEvents(src, "typescript").map((e) => [e.name, e.params.map((p) => p.name)])).toEqual([
      ["deleteOne", ["id"]],
      ["create-one", ["data"]],
      ["edit-one", ["data"]],
    ]);
  });
});

describe("Angular component outputs", () => {
  it("reads signal outputs, @Output fields and an alias, each where the class first emits it", () => {
    const src = `import { Component, EventEmitter, Output, output } from '@angular/core';

@Component({ selector: 'app-match-card', template: '' })
export class MatchCardComponent {
  readonly read = output<Match>();
  @Output() deleted = new EventEmitter<number>();
  @Output('cardRemoved') remove: EventEmitter<void> = new EventEmitter();

  onDelete(id: number) {
    this.deleted.emit(id);
  }
}`;
    expect(extractEvents(src, "typescript").map((e) => `${e.name} @${e.line}`)).toEqual(["read @5", "deleted @10", "cardRemoved @7"]);
    // Not an Angular file: no outputs.
    expect(extractEvents("const read = output();", "typescript")).toEqual([]);
  });
});

describe("Angular outputs fired with next", () => {
  it("places an EventEmitter output at its .next( call as it does at .emit(", () => {
    const src = `import { Component, EventEmitter, Output } from '@angular/core';

@Component({ selector: 'app-club-filter', template: '' })
export class ClubFilterComponent {
  @Output() rulesChange = new EventEmitter<string[]>();

  update(rules: string[]) {
    this.rulesChange.next(rules);
  }
}`;
    expect(extractEvents(src, "typescript").map((e) => `${e.name} @${e.line}`)).toEqual(["rulesChange @8"]);
  });
});

describe("an event emitted from several functions", () => {
  it("keeps every line it is emitted at, so each emitting function reaches the parent's handler (real-repo FP)", () => {
    const src = `<script setup>
const emit = defineEmits(['createTransfer', 'discard']);

async function handleSendMessage() {
  const ok = await emit('createTransfer', { club });
}

async function handleSendWireMessage() {
  await emit('createTransfer', { club, wire: true });
}

function close() {
  emit('discard');
}
</script>`;
    expect(extractEvents(src, "javascript").map((e) => [e.name, e.line, e.sites])).toEqual([
      ["createTransfer", 5, [5, 9]],
      ["discard", 13, undefined],
    ]);
  });

  it("keeps every line an Angular output is emitted at", () => {
    const src = `import { Component, output } from '@angular/core';

@Component({ selector: 'app-squad-list', template: '' })
export class SquadListComponent {
  readonly selected = output<number>();

  pick(id: number) {
    this.selected.emit(id);
  }

  pickFirst() {
    this.selected.emit(this.ids[0]);
  }
}`;
    expect(extractEvents(src, "typescript").map((e) => [e.name, e.line, e.sites])).toEqual([["selected", 8, [8, 12]]]);
  });
});
