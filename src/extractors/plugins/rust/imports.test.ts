import { describe, it, expect } from "vitest";
import { extractRustImports } from "./imports.js";

describe("Rust use declarations", () => {
  it("expands multi-line, nested and aliased uses into one import per parent path", () => {
    const imports = extractRustImports(`use activitypub_federation::config::Data;
use league_db_schema::{
  source::{
    community_report::{CommunityReport, UpdateCommunityReportForm},
    site::Site,
  },
  traits::Reportable,
};
use crate::utils::*;
use std::collections::HashMap as Map;
pub(crate) use super::helpers::{self, fmt};
`.split("\n"));
    expect(imports.map((i) => `${i.line} ${i.source} {${i.specifiers.join(",")}}`)).toEqual([
      "1 activitypub_federation::config {Data}",
      "2 league_db_schema::source::community_report {CommunityReport,UpdateCommunityReportForm}",
      "2 league_db_schema::source::site {Site}",
      "2 league_db_schema::traits {Reportable}",
      "9 crate::utils {}",
      "10 std::collections {Map}",
      "11 super {helpers}",
      "11 super::helpers {fmt}",
    ]);
  });

  it("keeps which declared name an aliased use binds", () => {
    const imports = extractRustImports(`use crate::garage::car::{Car as Motor, Wheel};
use crate::fleet::Van as _;
use std::collections::HashMap as Map;
`.split("\n"));
    expect(imports.map((i) => [i.source, i.specifiers, i.aliases])).toEqual([
      ["crate::garage::car", ["Motor", "Wheel"], { Motor: "Car" }],
      // An anonymous import (a trait brought into scope) binds no name.
      ["crate::fleet", ["_"], undefined],
      ["std::collections", ["Map"], { Map: "HashMap" }],
    ]);
  });

  it("binds the list's own module under its last segment for {self} and a lone {self}, and leaves {self as x} aliasing self", () => {
    const imports = extractRustImports(`use crate::squad::{self, Coach};
use crate::scoring::{self as sc};
use league_core::cup::{self};
use std::io::{self, Write};
`.split("\n"));
    expect(imports.map((i) => [i.source, i.specifiers, i.aliases])).toEqual([
      ["crate", ["squad"], undefined],
      ["crate::squad", ["Coach"], undefined],
      ["crate::scoring", ["sc"], { sc: "self" }],
      ["league_core", ["cup"], undefined],
      ["std", ["io"], undefined],
      ["std::io", ["Write"], undefined],
    ]);
  });
});
