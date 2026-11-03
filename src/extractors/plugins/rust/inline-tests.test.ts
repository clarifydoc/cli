import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string, filePath = "src/table.rs") => extractWithRegex(src.replace(/^\n/, ""), filePath, "rust");

describe("Rust inline tests", () => {
  const src = `
pub fn leader(clubs: &mut Vec<Club>) -> Option<&Club> {
    sort_clubs(clubs);
    clubs.first()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn club(name: &str, points: u32) -> Club {
        Club { name: name.to_string(), points }
    }

    #[test]
    fn finds_leader() {
        let mut clubs = vec![club("Rovers", 3)];
        assert_eq!(leader(&mut clubs).unwrap().name, "Rovers");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn summary_names_leader() {
        summary(&mut vec![]);
    }
}

#[test]
fn standalone_case() {
    leader(&mut vec![]);
}
`;

  it("marks #[test] functions as cases and the rest of a #[cfg(test)] module as helpers; production code stays unmarked", () => {
    const fns = analyze(src).functions;
    const of = (n: string) => fns.find((f) => f.name === n)!.testCase;
    expect(of("leader")).toBeUndefined();
    expect(of("club")).toEqual({ title: "club", path: ["tests"], kind: "helper" });
    expect(of("finds_leader")).toEqual({ title: "finds_leader", path: ["tests"], kind: "case" });
    expect(of("summary_names_leader")).toEqual({ title: "summary_names_leader", path: ["tests"], kind: "case" });
    expect(of("standalone_case")).toEqual({ title: "standalone_case", path: [], kind: "case" });
  });
});
