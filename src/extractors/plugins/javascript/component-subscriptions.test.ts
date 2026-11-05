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

describe("a dialog's own outcome, handled by the code that opened it", () => {
  it("reads closed / dismissed / result / afterClosed on the reference a dialog was opened with", async () => {
    const src = `export class SquadComponent {
  edit(club: Club) {
    const modalRef = this.modalService.open(EditClubModalComponent, { size: 'lg' });
    modalRef.closed.subscribe((result: ModalResult<Club>) => this.reload(result));
    modalRef.dismissed.pipe(take(1)).subscribe(() => this.reset());
  }
  rate(player: Player) {
    const ref = this.modalService.open(RatingModalComponent);
    ref.result.then((rating) => this.save(rating));
  }
  transfer() {
    const dialogRef = this.dialog.open(TransferDialogComponent);
    dialogRef.afterClosed().subscribe((fee) => this.pay(fee));
  }
  open() {
    this.ref.closed.subscribe(() => this.cleanUp());
  }
}`;
    const tree = await parseSource(src, "typescript" as never, "squad.component.ts");
    expect(componentSubscriptions(tree, src)).toEqual([
      { component: "EditClubModalComponent", event: "closed", line: 4, result: "close" },
      { component: "EditClubModalComponent", event: "dismissed", line: 5, result: "dismiss" },
      { component: "RatingModalComponent", event: "result", line: 9, result: "close" },
      { component: "TransferDialogComponent", event: "afterClosed", line: 13, result: "close" },
    ]);
  });
});
