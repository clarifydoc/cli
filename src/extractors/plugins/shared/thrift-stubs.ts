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

/** A stub hook: the spelling, the file it is in and, where core has it, every analyzed file. */
type StubHook = (spelling: string, file: FileAnalysis, project?: readonly FileAnalysis[]) => Stub;

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
  // The receiver may be an awaited connection: `(await connect()).createClient(ClubService)`.
  const m = /^(?:[\w$]+\.|\((?:await\s+)?[\w$.]*\((?:[^()]|\([^()]*\))*\)\)\.)?create(?:Http|Connection|WS|XHR)?Client\((?:[\w$]+\.)*([A-Z]\w*)\b/.exec(spelling);
  // `redis.createClient(Config)` is any library's: only a file importing `thrift` builds one.
  if (m) return imports(file, /^thrift(?:\/|$)/) ? { service: m[1]!, certain: true } : null;
  return jsNestedThriftStub(spelling, file);
}

/**
 * The directories of the project's Go packages the Thrift compiler wrote: a file declaring `ClubServiceClient`
 * beside `ClubServiceProcessor` (the generator writes both per service, `ClubServiceProcessorFunction`s too), or
 * sitting under a `gen-go/` directory. Read once per analysis.
 */
const generatedPackages = new WeakMap<readonly FileAnalysis[], Set<string>>();
function thriftGeneratedDirs(project: readonly FileAnalysis[]): Set<string> {
  let dirs = generatedPackages.get(project);
  if (dirs) return dirs;
  dirs = new Set();
  for (const f of project) {
    if (f.language !== "go") continue;
    const names = new Set(f.classes.map((c) => c.name));
    const generated = [...names].some((n) => n.endsWith("Client") && n.length > 6 && names.has(`${n.slice(0, -6)}Processor`));
    if (generated || /(?:^|\/)gen-go\//.test(f.filePath)) dirs.add(f.filePath.slice(0, Math.max(0, f.filePath.lastIndexOf("/"))));
  }
  generatedPackages.set(project, dirs);
  return dirs;
}

/** The file imports a package the project generated from a `.thrift` file (or sits in one), or a `gen-go/…` path. */
function importsGeneratedThrift(file: FileAnalysis | undefined, project: readonly FileAnalysis[] | undefined): boolean {
  if (!file) return false;
  if (file.imports.some((i) => /(?:^|\/)gen-go(?:\/|$)/.test(i.source))) return true;
  if (!project) return false;
  const dirs = thriftGeneratedDirs(project);
  if (dirs.size === 0) return false;
  const own = file.filePath.slice(0, Math.max(0, file.filePath.lastIndexOf("/")));
  if (dirs.has(own)) return true;
  // The import path ends with the directory the generated package sits in (module path + directory).
  return file.imports.some((i) => [...dirs].some((d) => (i.source === d || (d.includes("/") && i.source.endsWith(`/${d}`)))));
}

/** Go: `NewClubServiceClientFactory(trans, pf)`, `NewClubServiceClient(c)`, `NewClubServiceClientProtocol(…)`. */
export function goThriftStub(spelling: string, file?: FileAnalysis, project?: readonly FileAnalysis[]): Stub {
  const m0 = /^(?:\w+\.)?New(\w+)Client(?:Factory|Protocol)?\(\)$/.exec(spelling);
  const m1 = m0 ? null : /^\*?(?:\w+\.)?(\w+)Client$/.exec(spelling);
  if (!m0 && !m1) return null;
  const thrift = imports(file, /^github\.com\/apache\/thrift(?:\/|$)/);
  // The constructor is the compiler's own name; a bare type `ClubServiceClient` is any client of any
  // library, so it counts only in a file that imports the Thrift runtime or a package generated from a `.thrift`.
  const generated = !thrift && importsGeneratedThrift(file, project);
  const m = m0 ?? (thrift || generated ? m1 : null);
  if (!m || !/^[A-Z]/.test(m[1]!) || /^(?:HTTP|Http|Rest|REST|Redis|S3)$/.test(m[1]!)) return null;
  return { service: m[1]!, certain: thrift || generated };
}

/** The first hook with a certain answer, else the first with any. */
export function firstStub(...hooks: StubHook[]) {
  return (spelling: string, file: FileAnalysis, project?: readonly FileAnalysis[]): Stub => {
    let first: Stub = null;
    for (const h of hooks) {
      const s = h(spelling, file, project);
      if (s?.certain) return s;
      first ??= s;
    }
    return first;
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
