import { describe, it, expect } from "vitest";
import { extractGoResponses } from "../go/responses.js";
import { extractRubyResponses } from "../ruby/responses.js";
import { extractPhpResponses } from "../php/responses.js";
import { statusCode } from "./http-status.js";

const p = (name: string, type: string) => ({ name, type, defaultValue: null });

describe("handler responses outside JS", () => {
  it("reads status spellings", () => {
    expect(["201", "http.StatusCreated", ":unprocessable_entity", "Response::HTTP_NO_CONTENT", "HttpStatus.NOT_FOUND", "x"].map(statusCode)).toEqual([201, 201, 422, 204, 404, null]);
  });

  it("Go: gin/echo JSON with literal keys or typed bodies, fiber chains, net/http encoders, bare statuses", () => {
    const gin = extractGoResponses([
      "  var out CarDTO",
      "  if err != nil { c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{\"error\": err.Error()}); return }",
      "  c.JSON(http.StatusCreated, out)",
      "  c.JSON(200, gin.H{\"id\": o.ID, \"items\": items})",
      "  c.Status(http.StatusNoContent)",
    ], { name: "Create", params: [p("c", "*gin.Context")] });
    expect(gin).toEqual([{ status: 400, keys: ["error"] }, { status: 201, type: "CarDTO" }, { status: 200, keys: ["id", "items"] }, { status: 204 }]);
    expect(extractGoResponses(["  return c.Status(201).JSON(&Car{ID: 1})"], { name: "f", params: [p("c", "*fiber.Ctx")] })).toEqual([{ status: 201, type: "Car" }]);
    expect(extractGoResponses(["  w.WriteHeader(http.StatusAccepted)", "  json.NewEncoder(w).Encode(map[string]any{\"queued\": true})"], { name: "h", params: [p("w", "http.ResponseWriter"), p("r", "*http.Request")] })).toEqual([{ status: 202, keys: ["queued"] }]);
    expect(extractGoResponses(["  c.JSON(200, x)"], { name: "helper", params: [p("x", "int")] })).toEqual([]);
  });

  it("Ruby: render json with hashes, typed records and serializers, head, Sinatra json", () => {
    expect(extractRubyResponses([
      "    @car = Car.find(params[:id])",
      "    render json: @car, status: :ok",
      "    render json: { id: @car.id, total: @car.total,",
      "                   items: [] }, status: :created",
      "    render json: CarSerializer.new(@car)",
      "    head :no_content",
      "    render :edit",
    ])).toEqual([{ status: 200, type: "Car" }, { status: 201, keys: ["id", "items", "total"] }, { status: null, type: "CarSerializer" }, { status: 204 }]);
    expect(extractRubyResponses(["  status 201", "  json(id: player.id, \"name\" => player.name)"])).toEqual([{ status: 201, keys: ["id", "name"] }]);
    expect(extractRubyResponses(["  { ok: true }.to_json"])).toEqual([{ status: null, keys: ["ok"] }]);
  });

  it("PHP: Laravel json and resources, Symfony json and JsonResponse", () => {
    expect(extractPhpResponses(`{
      if (!$o) { return response()->json(['message' => 'missing'], 404); }
      return response()->json(['id' => $o->id, 'total' => $o->total], 201);
    }`)).toEqual([{ status: 404, keys: ["message"] }, { status: 201, keys: ["id", "total"] }]);
    expect(extractPhpResponses(`{ return new CarResource($car); }`)).toEqual([{ status: null, type: "CarResource" }]);
    expect(extractPhpResponses(`{ return CarResource::collection(Car::all()); }`)).toEqual([{ status: null, type: "CarResource[]" }]);
    expect(extractPhpResponses(`{ return $this->json($data, Response::HTTP_CREATED); }`)).toEqual([{ status: 201 }]);
    expect(extractPhpResponses(`{ return new JsonResponse(['ok' => true], 202); }`)).toEqual([{ status: 202, keys: ["ok"] }]);
    expect(extractPhpResponses(`{ return response()->noContent(); }`)).toEqual([{ status: 204 }]);
  });
});
