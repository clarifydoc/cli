import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { contextValues } from "./provide-inject.js";

describe("Vue provide/inject of a value by key", () => {
  it("reads what an ancestor provides by a literal key and what a descendant injects under it", async () => {
    const src = `import { provide, inject } from 'vue';
const transferPlayer = inject('transferPlayer');
const releasePlayer = inject("releasePlayer", () => {});
const squad = inject(SQUAD_KEY);
provide('signPlayer', onSignPlayer);
provide('scoutPlayer', (id) => scout(id));
provide(\`loanPlayer\`, this.onLoanPlayer);
function onSignPlayer(player) {
  transferPlayer(player);
}`;
    const tree = await parseSource(src, "typescript" as never, "Squad.vue");
    expect(contextValues(tree, src).filter((v) => !v.kind.endsWith("-typed"))).toEqual([
      { kind: "inject", key: "transferPlayer", name: "transferPlayer", line: 2 },
      { kind: "inject", key: "releasePlayer", name: "releasePlayer", line: 3 },
      { kind: "provide", key: "signPlayer", name: "onSignPlayer", line: 5 },
      { kind: "provide", key: "loanPlayer", name: "onLoanPlayer", line: 7 },
    ]);
  });

  it("names the factory a provided function was destructured from (real-repo FP)", async () => {
    const src = `import { provide } from 'vue';
import { useSquadActions } from './useSquadActions';
const { signPlayer, release: releasePlayer } = useSquadActions();
provide('signPlayer', signPlayer);
provide('releasePlayer', releasePlayer);`;
    const tree = await parseSource(src, "typescript" as never, "Squad.vue");
    expect(contextValues(tree, src).filter((v) => !v.kind.endsWith("-typed"))).toEqual([
      { kind: "provide", key: "signPlayer", name: "signPlayer", line: 4, from: "useSquadActions", member: "signPlayer" },
      { kind: "provide", key: "releasePlayer", name: "releasePlayer", line: 5, from: "useSquadActions", member: "release" },
    ]);
  });

  it("reads nothing from a file that never calls provide or inject", async () => {
    const src = `const club = useClub();`;
    const tree = await parseSource(src, "typescript" as never, "Club.vue");
    expect(contextValues(tree, src)).toEqual([]);
  });
});
