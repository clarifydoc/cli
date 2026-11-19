import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { goAddressedTypes } from "./addressed-types.js";

const src = (code: string) => code.split("\n");

describe("Go receiver kinds", () => {
  it("records a pointer receiver on the method and the types a file addresses", () => {
    const a = extractWithRegex(`package league

type Club struct{}
type Coach struct{}

func (c *Club) Sign(p string) error { return nil }
func (c Club) Name() string { return "" }
func NewClub() *Club { return &Club{} }
`, "league/club.go", "go");
    const club = a.classes.find((c) => c.name === "Club")!;
    expect(club.methods.find((m) => m.name === "Sign")!.pointerReceiver).toBe(true);
    expect(club.methods.find((m) => m.name === "Name")!.pointerReceiver).toBeUndefined();
    expect(a.addressedTypes).toEqual(["Club"]);
  });

  it("reads address forms and ignores a method receiver", () => {
    expect(goAddressedTypes(src(`
func (c *Coach) Sign() {}
func a() { x := Car{}; use(&x) }
func b() { _ = new(Garage); var p *pkg.Match }
// *Ghost
`))).toEqual(["Car", "Garage", "Match"]);
  });

  it("reads a parameter's address and survives a rune literal", () => {
    expect(goAddressedTypes(src(`
func add(c Club) { reg.Add(&c) }
func lex(r rune) { if r == '"' { return &Token{} } }
`))).toEqual(["Club", "Token"]);
  });

  it("links an interface call only to types whose method set holds the method", () => {
    const iface = extractWithRegex(`package league

type Signer interface {
	Sign(player string) error
}

func Hire(s Signer, p string) error {
	return s.Sign(p)
}
`, "league/signer.go", "go");
    const club = extractWithRegex(`package league

type Club struct{}

func (c *Club) Sign(player string) error { return nil }
func NewClub() *Club { return &Club{} }
`, "league/club.go", "go");
    // Coach is only ever a value, so its pointer-receiver Sign is no part of its method set.
    const coach = extractWithRegex(`package league

type Coach struct{}

func (c *Coach) Sign(player string) error { return nil }
func Retire() { k := Coach{}; _ = k }
`, "league/coach.go", "go");
    const links = buildSymbolLinks([iface, club, coach]);
    const targets = links.filter((l) => l.relation === "implements" || l.sourceFile === "league/signer.go").map((l) => l.targetFile);
    expect(targets).toContain("league/club.go");
    expect(targets).not.toContain("league/coach.go");
  });
});
