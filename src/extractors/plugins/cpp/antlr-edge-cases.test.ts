import { beforeAll, describe, expect, it } from "vitest";
import { readCpp } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const shape = (a: FileAnalysis) => [
  ...a.functions.map((f) => [f.name, f.calls.map((c) => c.name)]),
  ...a.classes.flatMap((c) => c.methods.map((m) => [`${c.name}::${m.name}`, m.calls.map((x) => x.name)])),
];

/** The syntax errors of the reading and, when none, the functions with the calls they make. */
const read = (source: string) => {
  const parsed = readCpp(source);
  return { errors: parsed.syntaxErrors, functions: parsed.syntaxErrors ? [] : shape(extractWithRegex(source, "league.cpp", "cpp", undefined, parsed)) };
};

describe("C++ edge cases: contextual keywords as names", () => {
  it("reads a variable named override or final, declared and used", () => {
    const source = `void host(int garageId) {
  Garage::OverrideCar override(findCar(garageId));
  Club final(3);
  override.park();
  final.play(override);
}
`;
    expect(read(source)).toEqual({ errors: 0, functions: [["host", ["findCar", "override.park", "final.play"]]] });
  });

  it("still takes them as specifiers after a declarator, a trailing return type and a class's name", () => {
    const source = `struct Car final : Vehicle {
  void start() const override;
  auto stop() -> Gear override { return shift(); }
  virtual void park() noexcept final;
};
class Garage final { void open() override { door(); } };
`;
    expect(read(source)).toEqual({ errors: 0, functions: [["Car::stop", ["shift"]], ["Garage::open", ["door"]]] });
  });
});
