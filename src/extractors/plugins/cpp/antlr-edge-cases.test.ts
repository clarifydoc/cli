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

describe("C++ edge cases: template arguments", () => {
  it("reads a comparison of a non-type template parameter inside template arguments", () => {
    const source = `template <size_t N>
using Bucket = std::conditional_t < N<256, uint8_t, uint16_t>;
template <size_t N>
void fill() { Bucket<N> b = assemble(); }
`;
    expect(read(source)).toEqual({ errors: 0, functions: [["fill", ["assemble"]]] });
  });

  it("reads a >> closing two levels before >=, a pack after nested closers in a requires clause, and a string argument", () => {
    const source = `template <class F, class Car, class Garage>
  requires std::is_invocable_v<F, Car, ref_t<std::tuple_element_t<0, Garage>>...>
decltype(auto) drive(F&& f) { return start(f); }

template <class T>
struct Rule<T, std::enable_if_t<(std::tuple_size_v<args_t<typename T::from_t>> >= 2)>> {
  void check() { run(); }
};

void label() {
  static_assert(has_slash(ref), join_v<chars<"Slash in name: \\"">, ref, chars<"\\" is bad">>);
  shift();
}
`;
    expect(read(source)).toEqual({ errors: 0, functions: [["drive", ["start"]], ["label", ["has_slash", "shift"]], ["Rule::check", ["run"]]] });
  });

  it("reads a call operator given template arguments without .template", () => {
    const source = `void run(Garage &g) { auto car = g.operator()<3>(); park(car); }\n`;
    expect(read(source)).toEqual({ errors: 0, functions: [["run", ["park"]]] });
  });
});

describe("C++ edge cases: macros standing for types", () => {
  it("reads a type macro in an alias, and a macro's call before `::` among template arguments and defaults", () => {
    const source = `template <class T>
using CarRef = const REMOVE_REF_(T) *;

template <class T, class E,
          bool = is_void_or<T, CAR_IS_COPYABLE(T)>::value && CAR_IS_COPYABLE(E)::value>
struct GarageBase : Base<T, E> {
  void park() { enter(); }
};

template <class T>
void drive(T t) {
  static_assert(CAR_IS_COPYABLE(T)::value, "copyable");
  typename CAR_TRAITS(T)::type gear = shift(t);
}
`;
    expect(read(source)).toEqual({ errors: 0, functions: [["drive", ["shift"]], ["GarageBase::park", ["enter"]]] });
  });

  it("keeps a macro's product in an expression a product", () => {
    expect(read(`int total(int a) { return SCALE(a) * 2; }\n`)).toEqual({ errors: 0, functions: [["total", ["SCALE"]]] });
  });
});
