import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { componentSubscriptions } from "./component-subscriptions.js";

describe("component output subscriptions", () => {
  it("reads the outputs of a dialog the code opens and subscribes to", async () => {
    const src = `export class SquadComponent {
  release(player: Player) {
    const modal = this.modalService.open(ConfirmDialogComponent, { backdrop: 'static' })
    modal.componentInstance.title = 'Release'
    modal.componentInstance.confirmClicked.pipe(first()).subscribe(() => {
      this.playerService.release(player.id).subscribe()
    })
  }
  edit(club: Club) {
    const ref = this.modalService.open(this.editDialog)
    ;(ref.componentInstance as ClubEditDialogComponent).saved.subscribe(() => this.reload())
    ref.componentInstance.failed.subscribe(() => this.toast())
  }
}`;
    const tree = await parseSource(src, "typescript" as never, "squad.component.ts");
    expect(componentSubscriptions(tree, src)).toEqual([
      { component: "ConfirmDialogComponent", event: "confirmClicked", line: 5 },
      { component: "ClubEditDialogComponent", event: "saved", line: 11 },
    ]);
  });
});
