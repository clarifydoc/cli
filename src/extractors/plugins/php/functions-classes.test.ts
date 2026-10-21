import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpExtractor } from "./functions-classes.js";
import type { ClassInfo } from "../../../types/analysis.js";

/**
 * CodeIgniter loads models dynamically (`$this->load->model('x')`), so
 * `$this->x_model->method()` has no declared type and the call linker could not
 * follow the controller→model edge — the edge that carries the DB tier into
 * Call Traces. The extractor synthesizes a typed property so the injection map
 * (which reads `cls.properties`) binds it.
 */
async function classesOf(src: string): Promise<ClassInfo[]> {
  const tree = await parseSource(src, "php" as any, "C.php");
  return new PhpExtractor().extractClasses(tree, src);
}

describe("CodeIgniter load->model synthetic injection properties", () => {
  it("adds a Ucfirst-typed property for each loaded model", async () => {
    const SRC = `<?php
class Site extends JAR_Controller {
  function show() {
    $this->load->model('drivers_model');
    $this->load->model('parts_model');
    return $this->drivers_model->get_driver(1);
  }
}`;
    const [cls] = await classesOf(SRC);
    const byName = Object.fromEntries(cls!.properties.map((p) => [p.name, p.type]));
    expect(byName["drivers_model"]).toBe("Drivers_model");
    expect(byName["parts_model"]).toBe("Parts_model");
  });

  it("honors the alias arg and strips a subdirectory path", async () => {
    const SRC = `<?php
class Admin extends JAR_Controller {
  function init() {
    $this->load->model('reports/sales_model', 'sales');
  }
}`;
    const [cls] = await classesOf(SRC);
    const byName = Object.fromEntries(cls!.properties.map((p) => [p.name, p.type]));
    // Bound to the alias object name; class is Ucfirst of the file basename.
    expect(byName["sales"]).toBe("Sales_model");
    expect(byName["sales_model"]).toBeUndefined();
  });

  it("does not invent properties for non-CI PHP", async () => {
    const SRC = `<?php
class Plain {
  public string $name;
  function go() { return $this->name; }
}`;
    const [cls] = await classesOf(SRC);
    expect(cls!.properties.map((p) => p.name)).toEqual(["name"]);
  });
});

/**
 * The attribute layer a request-schema pass needs: attributes with their
 * arguments, property decorators, promoted constructor properties, and the
 * nullability / required-ness of every property.
 */
describe("PHP 8 attributes and properties for the request schema", () => {
  it("keeps attribute arguments, on classes, methods, properties and promoted params", async () => {
    const SRC = `<?php
namespace App\\Dto;

use Symfony\\Component\\Serializer\\Annotation\\SerializedName;
use Symfony\\Component\\Validator\\Constraints as Assert;

#[Route('/api/players')]
#[IsGranted('ROLE_ADMIN')]
class CreatePlayerDto extends BaseDto
{
    #[SerializedName('full_name')]
    #[Assert\\NotBlank]
    public string $name;

    public ?Address $address = null;

    public array $tags = [];

    public static int $count = 0;

    private string $secret;

    public function __construct(
        #[Assert\\Email] public readonly string $email,
        private ?int $age = null,
        public \\DateTimeImmutable|null $bornAt = null,
    ) {}

    #[Route('/{id}', methods: ['POST'])]
    public function create(int $id): void {}
}`;
    const [cls] = await classesOf(SRC);
    expect(cls!.decorators).toEqual(["Route('/api/players')", "IsGranted('ROLE_ADMIN')"]);
    expect(cls!.methods.find((m) => m.name === "create")!.decorators).toEqual(["Route('/{id}', methods: ['POST'])"]);

    const byName = Object.fromEntries(cls!.properties.map((p) => [p.name, p]));
    expect(byName["name"]).toMatchObject({
      type: "string",
      visibility: "public",
      decorators: ["SerializedName('full_name')", "Assert\\NotBlank"],
      isRequired: true,
    });
    // Nullable keeps its `?`; a default initializer means not required.
    expect(byName["address"]).toMatchObject({ type: "?Address" });
    expect(byName["address"]!.isRequired).toBeUndefined();
    expect(byName["tags"]).toMatchObject({ type: "array" });
    expect(byName["tags"]!.isRequired).toBeUndefined();
    expect(byName["count"]).toMatchObject({ isStatic: true });
    expect(byName["secret"]).toMatchObject({ visibility: "private", isRequired: true });

    // Promoted constructor parameters are properties too.
    expect(byName["email"]).toMatchObject({
      type: "string", visibility: "public", isReadonly: true, decorators: ["Assert\\Email"], isRequired: true,
    });
    expect(byName["age"]).toMatchObject({ type: "?int", visibility: "private" });
    expect(byName["age"]!.isRequired).toBeUndefined();
    expect(byName["bornAt"]).toMatchObject({ type: "DateTimeImmutable|null" });
    // …and still constructor parameters (the call linker reads those).
    const ctor = cls!.methods.find((m) => m.name === "__construct")!;
    expect(ctor.params.map((p) => p.name)).toEqual(["email", "age", "bornAt"]);
  });

  it("finds classes inside a braced namespace block", async () => {
    const SRC = `<?php
namespace App\\Legacy {
    class Inner { public function go(): void {} }
}
namespace {
    function helper() {}
}`;
    const tree = await parseSource(SRC, "php" as any, "C.php");
    const ex = new PhpExtractor();
    expect(ex.extractClasses(tree, SRC).map((c) => c.name)).toEqual(["Inner"]);
    expect(ex.extractFunctions(tree, SRC).map((f) => f.name)).toEqual(["helper"]);
  });
});

describe("requestAccess — what a controller method reads from $request", () => {
  it("records body, query, header, route and form reads, and validation rule keys", async () => {
    const SRC = `<?php
class CarController extends Controller {
  public function store(Request $request, int $id)
  {
      $data = $request->validate([
          'driver_id' => 'required|integer',
          'items' => 'required|array',
          'items.*.sku' => 'string',
          'note' => ['nullable', 'string'],
      ]);
      $currency = $request->input('currency');
      $page = $request->query('page');
      $trace = $request->header('X-Trace');
      $carId = $request->route('car');
      $receipt = $request->file('receipt');
      $qty = $request->integer('qty');
      $token = $request->bearerToken();
      $status = $request->status;
      $all = $request->all();
      return $request->user();
  }
  public function index() { return Car::all(); }
}`;
    const [cls] = await classesOf(SRC);
    const store = cls!.methods.find((m) => m.name === "store")!;
    const access = store.requestAccess!;
    const key = (p: { binding: string | null; name: string }) => `${p.binding}:${p.name}`;
    expect(access.map(key)).toEqual(expect.arrayContaining([
      "body:driver_id", "body:items", "body:items.*.sku", "body:note",
      "body:currency", "body:qty", "body:status", "body:body",
      "query:page", "header:X-Trace", "header:Authorization", "route:car", "form:receipt",
    ]));
    expect(access.find((p) => p.name === "driver_id")!.type).toBe("int");
    expect(access.find((p) => p.name === "items")!.type).toBe("array");
    expect(access.find((p) => p.name === "qty")!.type).toBe("int");
    expect(access.find((p) => p.name === "receipt")!.type).toBe("UploadedFile");
    // `$request->user()` is a call, not a field; `->all()` reads the whole body once.
    expect(access.map(key)).not.toContain("body:user");
    expect(access.filter((p) => p.name === "body")).toHaveLength(1);
    // A method without a request parameter records nothing.
    expect(cls!.methods.find((m) => m.name === "index")!.requestAccess).toBeUndefined();
  });

  it("understands Symfony's request bags, $this->validate and the request() helper", async () => {
    const SRC = `<?php
class C {
  public function a(Request $request) {
      $q = $request->query->get('q');
      $n = $request->query->getInt('page');
      $x = $request->request->get('name');
      $h = $request->headers->get('X-Api-Key');
      $id = $request->attributes->get('id');
      $f = $request->files->get('upload');
      $raw = $request->getContent();
  }
  public function b(Request $req) {
      $this->validate($req, ['title' => 'required|string']);
      $lang = request()->input('lang');
      $ref = request('ref');
  }
}`;
    const [cls] = await classesOf(SRC);
    const key = (p: { binding: string | null; name: string }) => `${p.binding}:${p.name}`;
    const a = cls!.methods.find((m) => m.name === "a")!.requestAccess!;
    expect(a.map(key)).toEqual(expect.arrayContaining([
      "query:q", "query:page", "body:name", "header:X-Api-Key", "route:id", "form:upload", "body:body",
    ]));
    expect(a.find((p) => p.name === "page")!.type).toBe("int");
    // `$request->query->…` is a bag, not a body field named `query`.
    expect(a.map(key)).not.toContain("body:query");
    const b = cls!.methods.find((m) => m.name === "b")!.requestAccess!;
    expect(b.map(key)).toEqual(expect.arrayContaining(["body:title", "body:lang", "body:ref"]));
    expect(b.find((p) => p.name === "title")!.type).toBe("string");
  });
});

describe("Laravel FormRequest rules() as properties", () => {
  it("synthesizes a property per top-level rule key, typed and required from the rule", async () => {
    const SRC = `<?php
namespace App\\Http\\Requests;

use Illuminate\\Foundation\\Http\\FormRequest;

class StoreCarRequest extends FormRequest
{
    public function authorize(): bool { return true; }

    public function rules(): array
    {
        return [
            'driver_id' => 'required|integer|exists:drivers,id',
            'items' => 'required|array|min:1',
            'items.*.sku' => 'required|string',
            'note' => ['nullable', 'string', 'max:500'],
            'ship_on' => 'date',
        ];
    }
}`;
    const [cls] = await classesOf(SRC);
    const byName = Object.fromEntries(cls!.properties.map((p) => [p.name, p]));
    expect(Object.keys(byName)).toEqual(["driver_id", "items", "note", "ship_on"]);
    expect(byName["driver_id"]).toMatchObject({ type: "int", visibility: "public", isRequired: true, decorators: ['Rule("required|integer|exists:drivers,id")'] });
    expect(byName["items"]).toMatchObject({ type: "array", isRequired: true });
    expect(byName["note"]).toMatchObject({ type: "string" });
    expect(byName["note"]!.isRequired).toBeUndefined();
    expect(byName["ship_on"]).toMatchObject({ type: "DateTime" });
  });

  it("leaves a class without rules() alone", async () => {
    const SRC = `<?php
class LoginRequest extends FormRequest {
    public function authorize(): bool { return true; }
}`;
    const [cls] = await classesOf(SRC);
    expect(cls!.properties).toEqual([]);
  });
});
