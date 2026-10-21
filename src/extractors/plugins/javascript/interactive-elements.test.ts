import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractInteractiveElements, extractVueInteractiveElements } from "./interactive-elements.js";

async function handlersOf(src: string): Promise<Array<string | null>> {
  const tree = await parseSource(src, "typescript" as any, "C.tsx");
  return extractInteractiveElements(tree, src, "typescript").map((e) => e.handler);
}

describe("interactive elements — the handler an inline function runs", () => {
  it("skips event plumbing and conversions to reach the real call", async () => {
    const handlers = await handlersOf(`export function C() {
  return (<div>
    <button onClick={(e) => { e.stopPropagation(); onSelect(id); }}>a</button>
    <input onChange={(e) => setCount(Number(e.target.value))} />
    <a onClick={(e) => { e.preventDefault(); console.log("x"); navigate("/x"); }}>b</a>
  </div>);
}`);
    expect(handlers).toEqual(["onSelect", "setCount", "navigate"]);
  });

  it("falls back to the plumbing call when it is all there is", async () => {
    expect(await handlersOf(`export const C = () => <div onClick={(e) => e.stopPropagation()} />;`)).toEqual(["stopPropagation"]);
  });
});

describe("React Native controls", () => {
  it("reads Pressable and Touchable* as buttons, TextInput as an input", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    await import("../../registry.js");
    const { extractInteractiveElements } = await import("./interactive-elements.js");
    const src = `export function Checkout() {
  return (<View>
    <TextInput onChangeText={setEmail} />
    <Pressable onPress={submit}><Text>Pay</Text></Pressable>
    <TouchableOpacity onPress={() => cancel()} />
    <Button title="Back" onPress={goBack} />
    <PaymentSheet onDone={finish} />
  </View>);
}`;
    const tree = await parseSource(src, "typescript" as never, "Checkout.tsx");
    expect(extractInteractiveElements(tree, src, "typescript").map((e) => `${e.element} ${e.event} ${e.handler}`)).toEqual([
      "input onChangeText setEmail",
      "button onPress submit",
      "button onPress cancel",
      "button onPress goBack",
      "custom onDone finish",
    ]);
  });
});

describe("Vue template events", () => {
  it("reads a binding past a `>` inside another attribute's quoted value", () => {
    const template = `
  <DropdownMenuItem
    v-if="getInjuryOnDay.length > 0 || getAKUOnDay.length > 0"
    @click="editInjuryOrSuspension('Menu')"
  >Edit injury</DropdownMenuItem>`;
    const src = `<template>${template}</template>`;
    expect(extractVueInteractiveElements(template, src).map((e) => `${e.line} ${e.event} ${e.handler}`)).toEqual([
      "2 @click editInjuryOrSuspension('Menu')",
    ]);
  });

  it("reads a binding past an arrow function in a `:ref` (real-repo FP)", () => {
    const template = `
  <button
    :ref="(el) => registerShirt(player.index, el)"
    type="button"
    :class="{ 'squad__shirt--active': player.index === activeIndex }"
    :aria-current="player.index === activeIndex ? 'true' : undefined"
    @click="selectPlayer(player.index)"
  >
    <img :src="player.photoUrl" alt="" />
  </button>`;
    const src = `<template>${template}</template>`;
    expect(extractVueInteractiveElements(template, src).map((e) => `${e.line} ${e.element} ${e.event} ${e.handler}`)).toEqual([
      "2 button @click selectPlayer(player.index)",
    ]);
  });

  it("keeps both arrows of a pager whose `v-if` compares with `>` (real-repo FP)", () => {
    const template = `
  <div class="lineup">
    <button
      v-if="substitutes.length > 1"
      type="button"
      @click="step(-1)"
    >prev</button>
    <PlayerCard :player="current" />
    <button
      v-if="substitutes.length > 1"
      type="button"
      @click="step(1)"
    >next</button>
  </div>`;
    const src = `<template>${template}</template>`;
    expect(extractVueInteractiveElements(template, src).map((e) => `${e.line} ${e.element} ${e.event} ${e.handler}`)).toEqual([
      "3 button @click step(-1)",
      "9 button @click step(1)",
    ]);
  });

  it("reads a single-quoted handler that holds double quotes", () => {
    const template = `<button @click='pick("striker")'>Pick</button><a v-on:click='open("league")'>League</a>`;
    const src = `<template>${template}</template>`;
    expect(extractVueInteractiveElements(template, src).map((e) => `${e.event} ${e.handler}`)).toEqual([
      `@click pick("striker")`,
      `@click open("league")`,
    ]);
  });
});
