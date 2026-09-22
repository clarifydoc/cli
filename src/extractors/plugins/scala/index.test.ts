import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { scalaSpec } from "./index.js";

const classes = (src: string) => scalaSpec.extractClasses!(src.split("\n"), []);
const functions = (src: string) => extractFunctionsWithSpec(src.split("\n"), scalaSpec);

describe("scala heritage", () => {
  it("reads `extends` and every `with` mixin", () => {
    const [cls] = classes(`class OrderService(repo: Repo) extends BaseService with Logging with Metrics {\n}`);
    expect(cls.extends).toBe("BaseService");
    expect(cls.implements).toEqual(["Logging", "Metrics"]);
  });

  it("reads heritage wrapped onto a continuation line", () => {
    const [cls] = classes(
      [
        "class OrderController(cc: ControllerComponents, service: OrderService)",
        "    extends AbstractController(cc) with Logging {",
        "}",
      ].join("\n"),
    );
    expect(cls.extends).toBe("AbstractController");
    expect(cls.implements).toEqual(["Logging"]);
  });

  it("covers traits and objects, not just classes", () => {
    const found = classes(
      ["sealed trait OrderStatus extends Product", "case object Pending extends OrderStatus"].join("\n"),
    );
    expect(found.map((c) => [c.name, c.extends])).toEqual([
      ["OrderStatus", "Product"],
      ["Pending", "OrderStatus"],
    ]);
  });
});

describe("scala declarations without a body", () => {
  it("keeps a one-line case class from adopting the next declaration", () => {
    const found = classes(
      ["case class Order(id: Long)", "", "class OrderService {", "  def place(o: Order): Unit = {}", "}"].join("\n"),
    );
    const order = found.find((c) => c.name === "Order")!;
    expect(order.endLine).toBe(1);
    expect(order.methods).toEqual([]);
    expect(found.find((c) => c.name === "OrderService")!.methods.map((m) => m.name)).toEqual(["place"]);
  });

  it("gives an abstract def no calls from the code that follows it", () => {
    const [findById] = functions(
      ["def findById(id: Long): Future[Option[Order]]", "", "class Impl {", "  def run(): Unit = compute()", "}"].join("\n"),
    );
    expect(findById.calls).toEqual([]);
    expect(findById.returnType).toBe("Future[Option[Order]]");
  });
});

describe("scala members", () => {
  it("takes annotated val/var fields and leaves method locals alone", () => {
    const [cls] = classes(
      [
        "class OrderService {",
        "  private val tableName: String = \"orders\"",
        "  var retries: Int = 3",
        "  def place(o: Order): Order = {",
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
    const [fn] = functions("def place(order: Order, retries: Int = 3): Future[Order] = {\n}");
    expect(fn.params).toEqual([
      { name: "order", type: "Order", defaultValue: null },
      { name: "retries", type: "Int", defaultValue: "3" },
    ]);
  });
});
