import { describe, it, expect } from "vitest";
import { extractRustImports } from "./imports.js";

describe("Rust use declarations", () => {
  it("expands multi-line, nested and aliased uses into one import per parent path", () => {
    const imports = extractRustImports(`use activitypub_federation::config::Data;
use lemmy_db_schema::{
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
      "2 lemmy_db_schema::source::community_report {CommunityReport,UpdateCommunityReportForm}",
      "2 lemmy_db_schema::source::site {Site}",
      "2 lemmy_db_schema::traits {Reportable}",
      "9 crate::utils {}",
      "10 std::collections {Map}",
      "11 super::helpers {fmt}",
    ]);
  });
});
