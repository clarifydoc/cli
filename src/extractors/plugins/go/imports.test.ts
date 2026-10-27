import { describe, it, expect } from "vitest";
import { extractGoImports } from "./imports.js";

describe("extractGoImports", () => {
  it("reads bare, aliased, blank and dot imports — and only inside import declarations (real-repo FP)", () => {
    const src = `package routers

import "fmt"
import web "league.dev/modules/web"

import (
	"net/http" // stdlib

	packages_router "league.dev/routers/api/packages"
	_ "league.dev/modules/markup/external"
	. "league.dev/modules/testhelpers"
)

var contentTypes = []string{
	"application/json",
	"text/plain",
}
`;
    expect(extractGoImports(src.split("\n")).map((i) => `${i.line} ${i.source} [${i.specifiers.join(",")}]`)).toEqual([
      "3 fmt [fmt]",
      "4 league.dev/modules/web [web]",
      "7 net/http [http]",
      "9 league.dev/routers/api/packages [packages_router]",
      "10 league.dev/modules/markup/external []",
      "11 league.dev/modules/testhelpers [testhelpers]",
    ]);
  });

  it("reads a one-line import block", () => {
    expect(extractGoImports([`import ("os")`]).map((i) => i.source)).toEqual(["os"]);
  });
});
