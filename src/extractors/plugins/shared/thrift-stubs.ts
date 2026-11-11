import type { ClassInfo, FileAnalysis } from "../../../types/analysis.js";

/**
 * The Apache Thrift compiler's names for a client stub and a service
 * implementation, per language. They ride the same plugin hooks as protoc's
 * (`grpcStubService`, `grpcServiceOf` — read by `core/grpc-clients.ts` and
 * the symbol linker's spec join): a hook's job is "the RPC contract service
 * this generated name stands for", whatever IDL declared it. A `.thrift`
 * service is a contract row (`plugins/thrift`), so a stub of it joins like a
 * gRPC stub does, and a class implementing its generated `Iface` is what the
 * spec join finds.
 *
 * A spelling is certain only in a file importing the Thrift runtime; any
 * other counts only when a `.thrift` in the analysis declares the service, so
 * an unrelated class named `Client` or `Iface` links nothing.
 */
type Stub = { service: string; certain: boolean } | null;

const imports = (file: FileAnalysis | undefined, re: RegExp): boolean => !!file && file.imports.some((i) => re.test(i.source));

const NESTED = /^(?:new\s+)?(?:[\w$.]+\.)?([A-Z]\w*)\.(?:Client|AsyncClient|Iface|AsyncIface|IAsync)(?:\(\))?$/;

/** Java/Kotlin, C#, Python, JS: the nested `ClubService.Client` / `.Iface` the compiler generates. */
export function nestedThriftStub(runtime: RegExp) {
  return (spelling: string, file?: FileAnalysis): Stub => {
    const m = NESTED.exec(spelling);
    return m ? { service: m[1]!, certain: imports(file, runtime) } : null;
  };
}

export const jvmThriftStub = nestedThriftStub(/^org\.apache\.thrift(?:\.|$)/);
export const csharpThriftStub = nestedThriftStub(/^Thrift(?:\.|$)/);
export const pythonThriftStub = nestedThriftStub(/^thrift(?:\.|$)/);
const jsNestedThriftStub = nestedThriftStub(/^thrift(?:\/|$)/);

/**
 * JS/TS: the nested `ClubService.Client` the compiler generates, or the node library's
 * `thrift.createClient(ClubService, connection)` / `createHttpClient` / `createWSClient` /
 * `createXHRClient`, whose first argument names the service (core hands the names a call passes on
 * as `createClient(ClubService)`). Certain only in a file importing `thrift`.
 */
export function jsThriftStub(spelling: string, file?: FileAnalysis): Stub {
  const m = /^(?:[\w$]+\.)?create(?:Http|Connection|WS|XHR)?Client\((?:[\w$]+\.)*([A-Z]\w*)\b/.exec(spelling);
  // `redis.createClient(Config)` is any library's: only a file importing `thrift` builds one.
  if (m) return imports(file, /^thrift(?:\/|$)/) ? { service: m[1]!, certain: true } : null;
  return jsNestedThriftStub(spelling, file);
}

/** Go: `NewClubServiceClientFactory(trans, pf)`, `NewClubServiceClient(c)`, `NewClubServiceClientProtocol(…)`. */
export function goThriftStub(spelling: string, file?: FileAnalysis): Stub {
  const thrift = imports(file, /^github\.com\/apache\/thrift(?:\/|$)/);
  // The constructor is the compiler's own name; a bare type `ClubServiceClient` is any client of any
  // library, so it counts only in a file that imports the Thrift runtime.
  const m = /^(?:\w+\.)?New(\w+)Client(?:Factory|Protocol)?\(\)$/.exec(spelling) ?? (thrift ? /^\*?(?:\w+\.)?(\w+)Client$/.exec(spelling) : null);
  if (!m || !/^[A-Z]/.test(m[1]!) || /^(?:HTTP|Http|Rest|REST|Redis|S3)$/.test(m[1]!)) return null;
  return { service: m[1]!, certain: thrift };
}

/** The first hook with an answer. */
export function firstStub(...hooks: Array<(spelling: string, file: FileAnalysis) => Stub>) {
  return (spelling: string, file: FileAnalysis): Stub => {
    for (const h of hooks) {
      const s = h(spelling, file);
      if (s) return s;
    }
    return null;
  };
}

// ─── Servers: a class naming the generated `Iface` ────────────────────────────

const basesOf = (cls: ClassInfo): string[] => [cls.extends ?? "", ...cls.implements].filter(Boolean);

/** `implements ClubService.Iface` (Java), `: ClubService.Iface` (C#), `class Handler(ClubService.Iface)` (Python). */
export function thriftServiceOf(cls: ClassInfo): string | null {
  for (const b of basesOf(cls)) {
    const m = /(?:^|[.:])([A-Z]\w*)\.(?:Iface|AsyncIface|IAsync)$/.exec(b.replace(/<.*$/, ""));
    if (m) return m[1]!;
  }
  return null;
}

export function firstService(...hooks: Array<(cls: ClassInfo) => string | null>) {
  return (cls: ClassInfo): string | null => {
    for (const h of hooks) {
      const s = h(cls);
      if (s) return s;
    }
    return null;
  };
}
