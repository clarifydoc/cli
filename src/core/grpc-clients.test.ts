import { describe, it, expect } from "vitest";
import "../extractors/registry.js";
import { grpcClientCalls } from "./grpc-clients.js";
import { csharpGrpcStub, goGrpcStub, jsGrpcStub, jvmGrpcStub, pythonGrpcStub } from "../extractors/plugins/shared/grpc-stubs.js";
import type { CallInfo, FileAnalysis, FunctionInfo, RouteInfo } from "../types/analysis.js";

const file = (language: string, extra: Partial<FileAnalysis> = {}) => ({ filePath: `x.${language}`, language, imports: [], functions: [], classes: [], ...extra }) as unknown as FileAnalysis;
const goFile = file("go", { imports: [{ source: "google.golang.org/grpc", specifiers: [], isDefault: false, isNamespace: false, isType: false, line: 1 }] });

describe("protoc stub naming", () => {
  it("reads each language's stub types and the calls that build them", () => {
    expect(goGrpcStub("pb.NewOrderServiceClient()", goFile)).toEqual({ service: "OrderService", certain: true });
    expect(goGrpcStub("pb.OrderServiceClient", file("go"))).toEqual({ service: "OrderService", certain: false });
    expect(goGrpcStub("http.Client", goFile)).toBeNull();
    expect(goGrpcStub("redis.NewClient()", goFile)).toBeNull();
    expect(pythonGrpcStub("helloworld_pb2_grpc.GreeterStub")).toEqual({ service: "Greeter", certain: true });
    expect(pythonGrpcStub("GreeterStub")).toEqual({ service: "Greeter", certain: false });
    expect(jvmGrpcStub("OrderServiceGrpc.OrderServiceBlockingStub")).toEqual({ service: "OrderService", certain: true });
    expect(jvmGrpcStub("OrderServiceGrpc.newFutureStub()")).toEqual({ service: "OrderService", certain: true });
    expect(jvmGrpcStub("OrderServiceGrpcKt.OrderServiceCoroutineStub")).toEqual({ service: "OrderService", certain: true });
    expect(csharpGrpcStub("Greeter.GreeterClient")).toEqual({ service: "Greeter", certain: true });
    expect(csharpGrpcStub("Api.HttpClient")).toBeNull();
    expect(jsGrpcStub("OrderService", file("typescript"))).toBeNull();
    expect(jsGrpcStub("OrderService", file("typescript", { imports: [{ source: "@grpc/grpc-js" } as never] }))).toEqual({ service: "OrderService", certain: false });
  });
});

describe("gRPC client calls", () => {
  const call = (name: string, line = 5): CallInfo => ({ name, kind: "internal", target: null, line }) as CallInfo;
  const fn = (name: string, calls: string[], localTypes: FunctionInfo["localTypes"] = []): FunctionInfo =>
    ({ name, params: [], calls: calls.map((c) => call(c)), localTypes, line: 1, endLine: 9, decorators: [], isExported: true, isAsync: false }) as unknown as FunctionInfo;
  const rpc = (type: string, method: string) => ({ path: `/${type}/${method}`, httpMethod: "POST", kind: "api", handler: method, contract: { type, method }, calls: [], middleware: [], line: 1 }) as RouteInfo;

  it("calls a declared service at its rpc's path, the method as declared, plumbing left out", () => {
    const go = { ...goFile, functions: [fn("main", ["pb.NewOrderServiceClient", "client.GetOrder", "client.Close"], [{ name: "client", type: "", from: "pb.NewOrderServiceClient()" }])] } as FileAnalysis;
    const java = file("java", { classes: [{ name: "C", properties: [{ name: "stub", type: "OrderServiceGrpc.OrderServiceBlockingStub" }], methods: [fn("get", ["stub.withDeadlineAfter", "stub.getOrder"])] } as never] });
    const cs = file("csharp", { functions: [fn("Greet", ["client.SayHelloAsync"], [{ name: "client", type: "Greeter.GreeterClient" }])] });
    const calls = grpcClientCalls([go, java, cs], [rpc("acme.orders.v1.OrderService", "GetOrder"), rpc("helloworld.Greeter", "SayHello")]);
    expect(calls.map((c) => [c.filePath, c.name, c.target, c.contract])).toEqual([
      ["x.go", "POST /acme.orders.v1.OrderService/GetOrder", "/acme.orders.v1.OrderService/GetOrder", undefined],
      ["x.java", "POST /acme.orders.v1.OrderService/GetOrder", "/acme.orders.v1.OrderService/GetOrder", undefined],
      ["x.csharp", "POST /helloworld.Greeter/SayHello", "/helloworld.Greeter/SayHello", undefined],
    ]);
  });

  it("reads a chain on a fresh stub, a bare rpc after it, and a module-level stub, but never a response getter of the same name", () => {
    const go = { ...goFile, functions: [
      { ...fn("getAd", ["pb.NewAdServiceClient().GetAds", "resp.GetAds"]), calls: [call("pb.NewAdServiceClient().GetAds", 3), call("resp.GetAds", 6)] },
      { ...fn("currencies", []), calls: [call("pb.NewCurrencyServiceClient", 10), call("GetSupportedCurrencies", 11), call("Unrelated", 14)] },
    ] } as FileAnalysis;
    const py = file("python", { functions: [
      { ...fn("<setup>", []), calls: [call("demo_pb2_grpc.ProductCatalogServiceStub", 40)] },
      fn("ListRecommendations", ["product_catalog_stub.ListProducts", "response.ListProducts"]),
      // The project's own wrapper, typed: not the stub.
      fn("main", ["client.ListProducts"], [{ name: "client", type: "CatalogClient" }]),
    ] });
    const routes = [rpc("hipstershop.AdService", "GetAds"), rpc("hipstershop.CurrencyService", "GetSupportedCurrencies"), rpc("hipstershop.ProductCatalogService", "ListProducts")];
    expect(grpcClientCalls([go, py], routes).map((c) => `${c.filePath}:${c.line} ${c.name}`)).toEqual([
      "x.go:3 POST /hipstershop.AdService/GetAds",
      "x.go:11 POST /hipstershop.CurrencyService/GetSupportedCurrencies",
      "x.python:5 POST /hipstershop.ProductCatalogService/ListProducts",
    ]);
  });

  it("names a service no .proto here declares by its contract, and an uncertain spelling only when declared", () => {
    const py = file("python", { functions: [fn("run", ["stub.SayHello"], [{ name: "stub", type: "helloworld_pb2_grpc.GreeterStub" }])] });
    const js = file("typescript", { imports: [{ source: "@grpc/grpc-js" } as never], functions: [fn("go", ["client.getOrder", "cache.get"], [{ name: "client", type: "OrderService" }, { name: "cache", type: "Cache" }])] });
    const calls = grpcClientCalls([py, js], []);
    expect(calls.map((c) => [c.name, c.target, c.contract])).toEqual([["Greeter.SayHello", null, { type: "Greeter", method: "SayHello" }]]);
  });
});
