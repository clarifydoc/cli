import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const setupOf = (src: string, path: string) =>
  extractWithRegex(src, path, "swift", src.split("\n")).functions.find((f) => f.name === "<setup>");

describe("swift main.swift", () => {
  it("runs main.swift's top-level statements, with their typed locals, and no other file's", () => {
    const src = "let repo = PlayerRepo()\n_ = repo.save()\n";
    const setup = setupOf(src, "Sources/App/main.swift");
    expect(setup?.calls.map((c) => c.name)).toEqual(["PlayerRepo", "repo.save"]);
    expect(setup?.localTypes).toEqual([{ name: "repo", type: "PlayerRepo" }]);
    expect(setupOf(src, "Sources/App/Repo.swift")).toBeUndefined();
  });
});
