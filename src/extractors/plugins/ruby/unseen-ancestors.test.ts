import { describe, it, expect, beforeAll } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis, SymbolLink } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["ruby"]);
});

const read = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "ruby"), projectId: "root" });

const SAME_FILE = `def kick
  1
end

class Striker < UnseenPlayer
  def go
    kick()
  end
end

class Keeper
  def go
    kick()
  end
end

class Winger
  include UnseenSkills

  def go
    kick()
    dribble
  end

  def dribble
    2
  end
end

class Defender < Keeper
  def go
    kick()
  end
end
`;

const linkOf = (links: SymbolLink[], symbol: string, callName: string) =>
  links.filter((l) => l.sourceSymbol === symbol && l.callName === callName).map((l) => `${l.targetSymbol} ${l.confidence}`);

describe("Ruby: a bare call in a class with an ancestor the project does not declare", () => {
  it("is a guess when it lands outside the class — the unseen base or mixin may define it", () => {
    const links = buildSymbolLinks([read(SAME_FILE, "app/models/squad.rb")]);
    expect(linkOf(links, "Striker.go", "kick")).toEqual(["kick INFERRED"]);
    expect(linkOf(links, "Winger.go", "kick")).toEqual(["kick INFERRED"]);
  });

  it("stays extracted for a class whose ancestors the project declares, and for the class's own method", () => {
    const links = buildSymbolLinks([read(SAME_FILE, "app/models/squad.rb")]);
    expect(linkOf(links, "Keeper.go", "kick")).toEqual(["kick EXTRACTED"]);
    expect(linkOf(links, "Defender.go", "kick")).toEqual(["kick EXTRACTED"]);
    expect(linkOf(links, "Winger.go", "dribble")).toEqual(["Winger.dribble EXTRACTED"]);
  });
});
