import { describe, it, expect } from "vitest";
import { extractAngularInteractiveElementsFromTemplate, routerLinkTarget } from "./angular-template.js";

describe("routerLinkTarget", () => {
  it("reads a literal, a bound string and a segment array, runtime segments as {}", () => {
    expect(routerLinkTarget(` routerLink="/clubs"`)).toBe("/clubs");
    expect(routerLinkTarget(` routerLink="/clubs/{{ club.id }}?tab=squad"`)).toBe("/clubs/{}");
    expect(routerLinkTarget(` [routerLink]="'/league/table'"`)).toBe("/league/table");
    expect(routerLinkTarget(` [routerLink]="['/clubs', club.id, 'view']"`)).toBe("/clubs/{}/view");
    expect(routerLinkTarget(` [routerLink]="['/clubs/new']"`)).toBe("/clubs/new");
  });

  it("leaves a relative or computed link alone", () => {
    expect(routerLinkTarget(` routerLink="./edit"`)).toBeNull();
    expect(routerLinkTarget(` [routerLink]="['../', club.id]"`)).toBeNull();
    expect(routerLinkTarget(` [routerLink]="clubLink(club)"`)).toBeNull();
    expect(routerLinkTarget(` (click)="go()"`)).toBeNull();
  });
});

describe("Angular template links", () => {
  it("records a routerLink as a link element requesting the client route", () => {
    const els = extractAngularInteractiveElementsFromTemplate(`<nav>
  <a routerLink="/clubs" (click)="collapse()">Clubs</a>
  <a [routerLink]="['/clubs', club.id, 'edit']">Edit</a>
</nav>`);
    expect(els.map((e) => `${e.line} ${e.element} ${e.event} ${e.handler} ${e.request ? `${e.request.method} ${e.request.target}` : "-"}`)).toEqual([
      "2 link (click) collapse -",
      "2 link click null GET /clubs",
      "3 link click null GET /clubs/{}/edit",
    ]);
  });
});

describe("Angular output bindings", () => {
  it("names a component's tag and keeps an output emitted from the markup", () => {
    const els = extractAngularInteractiveElementsFromTemplate(`<app-match-card (deleted)="removeMatch($event)"></app-match-card>
<button (click)="read.emit(match)">Read</button>`);
    expect(els.map((e) => [e.element, e.event, e.handler, e.component ?? null])).toEqual([
      ["custom", "(deleted)", "removeMatch", "app-match-card"],
      ["button", "(click)", "read.emit", null],
    ]);
  });
});

describe("Angular key-filtered events", () => {
  it("reads (keyup.enter) as an event with its handler (real-repo FP)", () => {
    const els = extractAngularInteractiveElementsFromTemplate(`<input type="text" id="club-url"
       (keyup.enter)="loadClub()">`);
    expect(els.map((e) => [e.event, e.handler])).toEqual([["(keyup.enter)", "loadClub"]]);
  });
});

describe("Angular compound handlers", () => {
  it("keeps every call a handler's statements make, then the members they assign, never the event object (real-repo FP)", () => {
    const els = extractAngularInteractiveElementsFromTemplate(`<ngb-pagination (pageChange)="page.set($event); reloadClubs()"></ngb-pagination>
<button (click)="kickoffFrom = today; onChangeDebounce()">Today</button>
<button (click)="$event.preventDefault(); $event.stopPropagation(); closeMatch(m)">Close</button>
<button (click)="canEdit(club) ? openEditDialog(club) : null; $event.stopPropagation()">Edit</button>
<button (click)="goToRound(this.lastRound());resetTimer();">Last</button>
<button (click)="expanded = !expanded">More</button>
<button (click)="$event.stopPropagation()">Stop</button>
<app-transfer-row (dismissed)="transferStore.dismiss"></app-transfer-row>`);
    expect(els.map((e) => [e.handler, e.calls ?? []])).toEqual([
      ["page.set", ["reloadClubs"]],
      // An assignment runs code only through a setter: after the calls.
      ["onChangeDebounce", ["kickoffFrom"]],
      ["closeMatch", []],
      ["canEdit", ["openEditDialog"]],
      ["goToRound", ["resetTimer"]],
      ["expanded", []],
      ["$event.stopPropagation()", []],
      ["transferStore.dismiss", []],
    ]);
  });
});
