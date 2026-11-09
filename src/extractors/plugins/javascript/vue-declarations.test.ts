import { describe, it, expect } from "vitest";
import { readVueDeclarations } from "./vue-declarations.js";
import { parseVueSfc } from "../../../parsers/vue-sfc.js";

describe("readVueDeclarations — props", () => {
  it("reads the array form", () => {
    expect(readVueDeclarations(`const p = defineProps(['name', 'wins'])`).props).toEqual(["name", "wins"]);
  });
  it("reads the object form, one key per prop (nested options ignored)", () => {
    const src = `const p = defineProps({ name: String, wins: { type: Number, default: 0 }, 'home-ground': { type: Object, required: true } })`;
    expect(readVueDeclarations(src).props).toEqual(["name", "wins", "home-ground"]);
  });
  it("reads the type-only form", () => {
    const src = `const p = defineProps<{ name: string; wins?: number\n  onSelect?: (id: number) => void\n  stadium: { city: string; seats: number } }>()`;
    expect(readVueDeclarations(src).props).toEqual(["name", "wins", "onSelect", "stadium"]);
  });
  it("reads withDefaults(defineProps<…>(), …)", () => {
    const src = `const p = withDefaults(defineProps<{ name: string; wins?: number }>(), { wins: 0 })`;
    expect(readVueDeclarations(src).props).toEqual(["name", "wins"]);
  });
  it("reads an Options API props array and object", () => {
    expect(readVueDeclarations(`export default { props: ['name', 'wins'] }`).props).toEqual(["name", "wins"]);
    expect(readVueDeclarations(`export default { props: { name: String, wins: { type: Number } }, data() { return { x: 1 } } }`).props).toEqual(["name", "wins"]);
  });
  it("records an empty declaration as empty, and no declaration as absent", () => {
    expect(readVueDeclarations(`const p = defineProps([])`).props).toEqual([]);
    expect(readVueDeclarations(`const x = 1`).props).toBeUndefined();
  });
});

describe("readVueDeclarations — emits", () => {
  it("reads the array form", () => {
    expect(readVueDeclarations(`const emit = defineEmits(['save', 'transfer-player'])`).emits).toEqual(["save", "transfer-player"]);
  });
  it("reads the call-signature form, one signature several events", () => {
    const src = `const emit = defineEmits<{ (e: 'save', id: number): void; (e: 'sell' | 'loan'): void }>()`;
    expect(readVueDeclarations(src).emits).toEqual(["save", "sell", "loan"]);
  });
  it("reads the 3.3 shorthand", () => {
    const src = `const emit = defineEmits<{ save: [id: number]; 'kick-off': []; cancel: [] }>()`;
    expect(readVueDeclarations(src).emits).toEqual(["save", "kick-off", "cancel"]);
  });
  it("reads the object (validator) form and the Options API key", () => {
    expect(readVueDeclarations(`const emit = defineEmits({ save: (id) => id > 0, cancel: null })`).emits).toEqual(["save", "cancel"]);
    expect(readVueDeclarations(`export default { emits: ['save'], props: ['name'] }`).emits).toEqual(["save"]);
  });
  it("reads no emits where none are declared", () => {
    expect(readVueDeclarations(`const emit = useEmit()`).emits).toBeUndefined();
  });
});

describe("a parent's listeners are not props", () => {
  it("keeps @event and v-on:event out of a tag's props and lists them as listeners", () => {
    const sfc = parseVueSfc(`<template><ClubCard name="a" :wins="3" @save="onSave" v-on:cancel.once="onCancel" @update:modelValue="x = $event" /></template>`);
    const card = sfc.templateComponents.find((c) => c.name === "ClubCard")!;
    expect(card.props).toEqual(["name", "wins"]);
    expect(card.listeners).toEqual(["save", "cancel", "update:modelValue"]);
  });
});
