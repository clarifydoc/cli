import { describe, it, expect } from "vitest";
import { markupCalls } from "./markup-calls.js";
import type { InteractiveElementInfo } from "../../../types/analysis.js";

const el = (handler: string, line: number): InteractiveElementInfo => ({ element: "button", event: "@click", handler, line });

describe("calls a single-file component's template makes", () => {
  it("names a handler, a member chain, and each callee an inline handler spells — never the emit", () => {
    const calls = markupCalls([
      el("markAllRead", 3),
      el("clubStore.actions.deleteOne", 4),
      el("saveClub(club.id)", 5),
      el("(club) => { selectClub(club); dialog = false }", 6),
      el("$emit('close')", 7),
      el("showMenu = !showMenu", 8),
    ], "web/components/ClubList.vue");
    expect(calls.map((c) => [c.name, c.line])).toEqual([
      ["markAllRead", 3],
      ["clubStore.actions.deleteOne", 4],
      ["saveClub", 5],
      ["selectClub", 6],
    ]);
  });

  it("gives none for JSX, whose handlers sit inside the component function", () => {
    expect(markupCalls([el("saveClub", 3)], "web/components/ClubList.tsx")).toEqual([]);
  });
});
