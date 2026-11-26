import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { discoverFiles } from "./file-discovery.js";
import { summarizeUnreadCode, unreadCodeLine } from "./unread-code.js";
import { EXTENSION_TO_LANGUAGE, UNCLAIMED_CODE_EXTENSIONS } from "../extractors/registry.js";

describe("code no plugin reads", () => {
  it("is never an extension a plugin claims", () => {
    for (const ext of UNCLAIMED_CODE_EXTENSIONS.keys()) expect(EXTENSION_TO_LANGUAGE[ext]).toBeUndefined();
    expect(UNCLAIMED_CODE_EXTENSIONS.get(".sol")).toBe("Solidity");
    expect(UNCLAIMED_CODE_EXTENSIONS.has(".ts")).toBe(false);
  });

  it("counts unread code by extension from paths, leaving out vendored roots, ignored folders and claimed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-unread-"));
    try {
      const files: Record<string, string> = {
        "contracts/Match.sol": "contract Match {}",
        "contracts/Club.sol": "contract Club {}",
        "contracts/Match.ts": "export const match = 1;",
        "ui/Player.elm": "module Player exposing (..)",
        "third_party/lib/Engine.sol": "contract Engine {}",
        "node_modules/pkg/Car.nix": "{}",
        "garage/car.nix": "{ car = 1; }",
        "ignored/Referee.sol": "contract Referee {}",
        "data/readme.txt": "{}",
        ".clarifydocignore": "ignored/\n",
      };
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const found = await discoverFiles(root);
      expect(found.files.map((f) => f.relativePath)).toEqual(["contracts/Match.ts"]);
      const unread = summarizeUnreadCode(found.unreadCode);
      expect(unread.map((u) => `${u.extension}:${u.files}`)).toEqual([".sol:2", ".elm:1", ".nix:1"]);
      expect(unread[0]!.examples).toEqual(["contracts/Club.sol", "contracts/Match.sol"]);
      expect(unreadCodeLine(unread)).toBe("4 code files no plugin reads, so they are not in the map: 2 Solidity (.sol), 1 Elm (.elm), 1 Nix (.nix)");
      expect(unreadCodeLine([])).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
