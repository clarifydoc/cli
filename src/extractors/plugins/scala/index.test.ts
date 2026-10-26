import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { scalaSpec } from "./index.js";

const classes = (src: string) => scalaSpec.extractClasses!(src.split("\n"), []);
const functions = (src: string) => extractFunctionsWithSpec(src.split("\n"), scalaSpec);

describe("scala heritage", () => {
  it("reads `extends` and every `with` mixin", () => {
    const [cls] = classes(`class CarService(repo: Repo) extends BaseService with Logging with Metrics {\n}`);
    expect(cls.extends).toBe("BaseService");
    expect(cls.implements).toEqual(["Logging", "Metrics"]);
  });

  it("reads heritage wrapped onto a continuation line", () => {
    const [cls] = classes(
      [
        "class CarController(cc: ControllerComponents, service: CarService)",
        "    extends AbstractController(cc) with Logging {",
        "}",
      ].join("\n"),
    );
    expect(cls.extends).toBe("AbstractController");
    expect(cls.implements).toEqual(["Logging"]);
  });

  it("covers traits and objects, not just classes", () => {
    const found = classes(
      ["sealed trait CarStatus extends Product", "case object Pending extends CarStatus"].join("\n"),
    );
    expect(found.map((c) => [c.name, c.extends])).toEqual([
      ["CarStatus", "Product"],
      ["Pending", "CarStatus"],
    ]);
  });
});

describe("scala declarations without a body", () => {
  it("keeps a one-line case class from adopting the next declaration", () => {
    const found = classes(
      ["case class Car(id: Long)", "", "class CarService {", "  def place(o: Car): Unit = {}", "}"].join("\n"),
    );
    const car = found.find((c) => c.name === "Car")!;
    expect(car.endLine).toBe(1);
    expect(car.methods).toEqual([]);
    expect(found.find((c) => c.name === "CarService")!.methods.map((m) => m.name)).toEqual(["place"]);
  });

  it("gives an abstract def no calls from the code that follows it", () => {
    const [findById] = functions(
      ["def findById(id: Long): Future[Option[Car]]", "", "class Impl {", "  def run(): Unit = compute()", "}"].join("\n"),
    );
    expect(findById.calls).toEqual([]);
    expect(findById.returnType).toBe("Future[Option[Car]]");
  });
});

describe("scala members", () => {
  it("takes annotated val/var fields and leaves method locals alone", () => {
    const [cls] = classes(
      [
        "class CarService {",
        "  private val tableName: String = \"cars\"",
        "  var retries: Int = 3",
        "  def place(o: Car): Car = {",
        "    val validated = validate(o)",
        "    validated",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(cls.properties.map((p) => [p.name, p.type, p.visibility, p.isReadonly])).toEqual([
      ["tableName", "String", "private", true],
      ["retries", "Int", "public", false],
    ]);
  });

  it("parses `name: Type` parameters", () => {
    const [fn] = functions("def place(car: Car, retries: Int = 3): Future[Car] = {\n}");
    expect(fn.params).toEqual([
      { name: "car", type: "Car", defaultValue: null },
      { name: "retries", type: "Int", defaultValue: "3" },
    ]);
  });
});

describe("scala package clause", () => {
  const pkg = (src: string) => scalaSpec.extractPackageName!(src.split("\n"), "modules/clubs/src/main/Table.scala");
  it("joins chained clauses and stops at the first declaration", () => {
    expect(pkg(`// header\npackage league\npackage clubs\n\nimport league.stats.Pair\nobject Table`)).toBe("league.clubs");
    expect(pkg(`package league.clubs\n\nfinal class ClubApi`)).toBe("league.clubs");
  });
  it("reads no package from a package object or a file without one", () => {
    expect(pkg(`package object clubs {\n}`)).toBeNull();
    expect(pkg(`object Main`)).toBeNull();
  });
});
