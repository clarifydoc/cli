import type { ClassInfo, FileAnalysis } from "../../../types/analysis.js";

/**
 * protoc's names for a gRPC client stub, per language — what each plugin's
 * `grpcStubService` hook answers (see `core/grpc-clients.ts`). A spelling is a
 * declared type or a local's initializer as `callChainText` writes it.
 */
type Stub = { service: string; certain: boolean } | null;

const imports = (file: FileAnalysis, re: RegExp): boolean => file.imports.some((i) => re.test(i.source));

/** Go: `pb.NewOrderServiceClient()` / `pb.OrderServiceClient` — certain in a file importing grpc. */
export function goGrpcStub(spelling: string, file: FileAnalysis): Stub {
  const m = /^(?:\w+\.)?New(\w+)Client\(\)$/.exec(spelling) ?? /^\*?\w+\.(\w+)Client$/.exec(spelling);
  if (!m || !/^[A-Z]/.test(m[1]!) || /^(?:HTTP|Http|Rest|REST|Redis|S3)$/.test(m[1]!)) return null;
  return { service: m[1]!, certain: imports(file, /^google\.golang\.org\/grpc(?:\/|$)/) };
}

/** Python: `helloworld_pb2_grpc.GreeterStub` (or the call building it). */
export function pythonGrpcStub(spelling: string): Stub {
  const m = /^(?:(\w+)\.)?(\w+)Stub(?:\(\))?$/.exec(spelling);
  if (!m || !/^[A-Z]/.test(m[2]!)) return null;
  return { service: m[2]!, certain: /_pb2_grpc$/.test(m[1] ?? "") };
}

/**
 * Java/Kotlin: `OrderServiceGrpc.OrderServiceBlockingStub`, `OrderServiceGrpc.newStub()`,
 * `…GrpcKt.…CoroutineStub` — or the bare nested class a file imports
 * (`import demo.OrderServiceGrpc.OrderServiceBlockingStub;`).
 */
export function jvmGrpcStub(spelling: string, file?: FileAnalysis): Stub {
  const m = /^(?:[\w.]+\.)?(\w+)Grpc(?:Kt)?\.(?:new(?:Blocking(?:V2)?|Future)?Stub\(\)|\w+?(?:Blocking(?:V2)?|Future|Coroutine)?Stub)$/.exec(spelling);
  if (m) return { service: m[1]!, certain: true };
  if (!file || !/^\w+Stub$/.test(spelling)) return null;
  const nested = file.imports.map((i) => new RegExp(`(?:^|\\.)(\\w+)Grpc(?:Kt)?\\.${spelling}$`).exec(i.source)).find(Boolean);
  return nested ? { service: nested[1]!, certain: true } : null;
}

/** C#: the nested `Greeter.GreeterClient` protoc generates (or `new Greeter.GreeterClient(…)`). */
export function csharpGrpcStub(spelling: string): Stub {
  const m = /^(?:new\s+)?(?:[\w.]+\.)?(\w+)\.(\w+)Client(?:\(\))?$/.exec(spelling);
  return m && m[1] === m[2] ? { service: m[1]!, certain: true } : null;
}

/** JS/TS: a client class `@grpc/grpc-js` loads from a proto at run time — only a declared service counts. */
export function jsGrpcStub(spelling: string, file: FileAnalysis): Stub {
  if (!imports(file, /^(?:@grpc\/grpc-js|grpc)$/)) return null;
  // ts-proto / grpc-js clients are named `<Service>Client`.
  const m = /^(?:new\s+)?(?:[\w$.]+\.)?([A-Z]\w*?)(?:Client)?(?:\(\))?$/.exec(spelling);
  return m ? { service: m[1]!, certain: false } : null;
}

// ─── Servers: the class protoc's generated base says implements a service ─────

const basesOf = (cls: ClassInfo): string[] => [cls.extends ?? "", ...cls.implements].filter(Boolean);

/** Java/Kotlin: `extends OrderServiceGrpc.OrderServiceImplBase` (also `…CoroutineImplBase`). */
export function jvmGrpcService(cls: ClassInfo): string | null {
  for (const b of basesOf(cls)) {
    const m = /(?:^|\.)(\w+)Grpc(?:Kt)?\.(\w+?)(?:Coroutine)?ImplBase$/.exec(b.replace(/<.*$/, ""));
    if (m && m[1] === m[2]) return m[1]!;
  }
  return null;
}

/** C#: `: Greeter.GreeterBase`. */
export function csharpGrpcService(cls: ClassInfo): string | null {
  for (const b of basesOf(cls)) {
    const m = /(?:^|\.)(\w+)\.(\w+)Base$/.exec(b);
    if (m && m[1] === m[2]) return m[1]!;
  }
  return null;
}

/** Python: `class Greeter(helloworld_pb2_grpc.GreeterServicer)`. */
export function pythonGrpcService(cls: ClassInfo): string | null {
  for (const b of basesOf(cls)) {
    const m = /^(?:\w+_pb2_grpc\.)?([A-Z]\w*)Servicer$/.exec(b);
    if (m) return m[1]!;
  }
  return null;
}

/** Go: a struct embedding `pb.UnimplementedOrderServiceServer`. */
export function goGrpcService(cls: ClassInfo): string | null {
  for (const p of cls.properties) {
    if (!p.decorators?.includes("embedded")) continue;
    const m = /(?:^|\.)Unimplemented(\w+)Server$/.exec((p.type ?? p.name).replace(/^\*/, ""));
    if (m) return m[1]!;
  }
  return null;
}

/** C++: `: public demo::CurrencyService::Service` (kept in `implements` by the plugin). */
export function cppGrpcService(cls: ClassInfo): string | null {
  for (const b of basesOf(cls)) {
    const m = /(?:^|::)(\w+)::Service$/.exec(b);
    if (m) return m[1]!;
  }
  return null;
}

