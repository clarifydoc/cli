import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractInteractiveElements } from "./interactive-elements.js";

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
