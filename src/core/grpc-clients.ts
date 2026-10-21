import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo, RouteInfo } from "../types/analysis.js";
import { pluginFor } from "../extractors/registry.js";
import { SELF_HEADS, isConstructor } from "./typed-receivers.js";

type ApiCall = DataSourceInfo & { filePath: string };

/**
 * Calls through gRPC client stubs, as outbound API calls on the rpc they invoke.
 *
 *   client := pb.NewOrderServiceClient(conn); client.GetOrder(ctx, req)       // Go
 *   stub = helloworld_pb2_grpc.GreeterStub(channel); stub.SayHello(req)       // Python
 *   OrderServiceGrpc.newBlockingStub(ch).getOrder(req) via a typed field      // Java/Kotlin
 *   await _client.SayHelloAsync(req)  // Greeter.GreeterClient, injected       // C#
 *
 * Nothing at the call site says HTTP/2 or a URL. What is stated: the stub's
 * type or the call that built it, which the language's plugin reads as a
 * service (`grpcStubService`, protoc's naming), and the method called on it.
 * Each such call becomes an api-call on the rpc: at the rpc row's own path
 * (`POST /acme.orders.v1.OrderService/GetOrder`) when a `.proto` in the
 * analysis declares the service — a stub speaks gRPC, so a grpc-gateway REST
 * binding of the same operation is never what it reaches — and otherwise
 * carrying `contract { type, method }`, the operation a protobuf contract
 * row declares wherever it is (another repository).
 *
 * The client names its service without the proto package
 * (`OrderService`); when one `.proto` in the analysis declares a service of
 * that name, the contract is qualified with its package
 * (`acme.orders.v1.OrderService`) and the method matched to the declared rpc
 * (`getOrder`/`GetOrderAsync` → `GetOrder`). A spelling the plugin is not
 * certain of counts only when such a service exists.
 *
 * Two shapes state no type at the call: a chain the extractor reads as two
 * calls (`pb.NewOrderServiceClient(conn).GetOrder(…)` → the stub, then a bare
 * `GetOrder` on the same or the next line), and a stub kept in a variable no
 * function declares (`stub = …Stub(channel)` at module level, a receiver
 * named `…stub`/`…client`). Both count only for a stub the file builds whose
 * service declares an rpc of exactly that name.
 */

/** Stub members that are not rpcs: call options, channel plumbing, object methods. */
const NOT_RPC = /^(?:with[A-Z]\w*|getChannel|close|waitForReady|makeUnaryRequest|makeClientStreamRequest|makeServerStreamRequest|makeBidiStreamRequest|Dispose|DisposeAsync|ToString|Equals|GetHashCode|getClass|hashCode|toString|equals)$/;

export function grpcClientCalls(analyses: readonly FileAnalysis[], routes: readonly RouteInfo[]): ApiCall[] {
  // The services the analysis declares, by simple name → qualified names and their rpcs.
  const declared = new Map<string, Map<string, Set<string>>>();
  for (const r of routes) {
    // A code row serving an operation by its contract (a grpc-js handler) declares no service.
    if (!r.contract || r.prefixUnresolved?.startsWith("contract:")) continue;
    const leaf = r.contract.type.slice(r.contract.type.lastIndexOf(".") + 1);
    const byType = declared.get(leaf) ?? declared.set(leaf, new Map()).get(leaf)!;
    (byType.get(r.contract.type) ?? byType.set(r.contract.type, new Set()).get(r.contract.type)!).add(r.contract.method);
  }

  const out: ApiCall[] = [];
  for (const a of analyses) {
    const hook = pluginFor(a.language)?.grpcStubService;
    if (!hook) continue;
    const serviceOf = (spelling: string | null | undefined): string | null => {
      if (!spelling) return null;
      const s = hook(spelling.trim(), a);
      if (!s) return null;
      return s.certain || declared.has(s.service) ? s.service : null;
    };

    // The stubs this file builds anywhere (`<setup>` included), with the lines it builds them on.
    const built = new Map<string, number[]>();
    for (const fn of [...a.functions, ...a.classes.flatMap((c) => c.methods)]) {
      for (const c of fn.calls) {
        const s = serviceOf(`${c.name}()`);
        if (s) (built.get(s) ?? built.set(s, []).get(s)!).push(c.line);
      }
    }
    /** The one built service that declares `method` as an rpc. */
    const builtDeclaring = (method: string, near?: number): string | null => {
      const hits = [...built].filter(([svc, lines]) => {
        const types = declared.get(svc);
        const want = method.replace(/Async$/, "").toLowerCase();
        if (types?.size !== 1 || ![...[...types.values()][0]!].some((m) => m.toLowerCase() === want)) return false;
        return near === undefined || lines.some((l) => near >= l && near <= l + 1);
      });
      return hits.length === 1 ? hits[0]![0] : null;
    };

    const emit = (fn: FunctionInfo, scope: ReadonlyMap<string, string>) => {
      if (scope.size === 0 && built.size === 0) return;
      // Names this function declares with a type of their own (`AdServiceClient client = new …`): never an untyped stub.
      const typed = new Set([...fn.params.filter((p) => p.type).map((p) => p.name), ...(fn.localTypes ?? []).filter((l) => l.type || l.from).map((l) => l.name)]);
      for (const call of fn.calls) {
        // `OrderServiceGrpc.newBlockingStub(channel).getOrder`, `pb.NewOrderServiceClient().GetOrder`: an rpc on the stub just built.
        const chained = /^(.+)\((?:[^()]|\([^()]*\))*\)\.([A-Za-z_]\w*)$/.exec(call.name);
        const parts = chained ? [chained[2]!] : call.name.split(".");
        let service: string | null | undefined;
        if (chained) {
          service = serviceOf(`${chained[1]}()`);
        } else if (parts.length === 1) {
          // `pb.NewOrderServiceClient(conn).GetOrder(ctx, req)`, read as two calls: the stub, then a bare rpc on it.
          service = builtDeclaring(parts[0]!, call.line);
        } else {
          let receiver = parts.slice(0, -1);
          if (receiver.length === 2 && SELF_HEADS.has(receiver[0]!)) receiver = receiver.slice(1);
          if (receiver.length !== 1) continue;
          // A typed receiver, else a stub the file builds where no type is stated (a module-level
          // `stub = …Stub(channel)`) — named as one: `resp.GetAds()` is the response's getter of the same name.
          service = scope.get(receiver[0]!) ?? (/stub|client/i.test(receiver[0]!) && !typed.has(receiver[0]!) ? builtDeclaring(parts[parts.length - 1]!) : null);
        }
        const called = parts[parts.length - 1]!;
        if (!service || !/^[A-Za-z_]\w*$/.test(called) || NOT_RPC.test(called)) continue;
        // Qualify through the one declared service of that name, and name the rpc as declared.
        const types = declared.get(service);
        const type = types?.size === 1 ? [...types.keys()][0]! : service;
        const rpcs = types?.size === 1 ? [...types.values()][0]! : undefined;
        const bare = called.replace(/Async$/, "");
        const declaredRpc = rpcs && ([...rpcs].find((m) => m.toLowerCase() === called.toLowerCase()) ?? [...rpcs].find((m) => m.toLowerCase() === bare.toLowerCase()));
        // A declared service answers only its rpcs: `client.Close()` is no call.
        if (rpcs && !declaredRpc) continue;
        const method = declaredRpc ?? bare[0]!.toUpperCase() + bare.slice(1);
        // A service the analysis declares is called at its rpc's own path — over gRPC, never at a
        // grpc-gateway REST binding of the same operation. One declared elsewhere is named by its contract.
        const path = rpcs ? `/${type}/${method}` : null;
        out.push({
          kind: "api-call",
          name: path ? `POST ${path}` : `${service}.${method}`,
          target: path,
          line: call.line,
          calls: [],
          filePath: a.filePath,
          ...(path ? {} : { contract: { type, method } }),
          baseRef: { kind: "client", key: service },
        });
      }
    };
    const scopeOf = (fn: FunctionInfo, members: ReadonlyMap<string, string>, owner?: string) => {
      const scope = new Map(members);
      for (const p of fn.params) {
        const s = serviceOf(p.type);
        if (s) scope.set(p.name, s);
      }
      // A receiver's own name (Go's `cs` in `func (cs *checkout) …`, a local typed as the class) heads a member like `this`.
      const selfNames = new Set([...SELF_HEADS, ...fn.params.filter((p) => p.isReceiver).map((p) => p.name), ...(fn.localTypes ?? []).filter((l) => l.type && owner && l.type.replace(/^\*/, "") === owner).map((l) => l.name)]);
      for (const l of fn.localTypes ?? []) {
        // `paymentService := cs.paymentSvcClient`: the member's stub.
        const alias = l.from ? /^(\w+)\.(\w+)$/.exec(l.from) : null;
        const s = serviceOf(l.type) ?? serviceOf(l.from) ?? (alias && selfNames.has(alias[1]!) ? members.get(alias[2]!) : undefined);
        if (s) scope.set(l.name, s);
      }
      return scope;
    };
    const membersOf = (cls: ClassInfo) => {
      const members = new Map<string, string>();
      for (const p of cls.properties) {
        const s = serviceOf(p.type);
        if (s) members.set(p.name, s);
      }
      for (const m of cls.methods) {
        if (!isConstructor(m, cls)) continue;
        for (const p of m.params) {
          const s = serviceOf(p.type);
          if (s) members.set(p.name, s);
        }
      }
      return members;
    };

    const none = new Map<string, string>();
    for (const fn of a.functions) emit(fn, scopeOf(fn, none));
    for (const cls of a.classes) {
      const members = membersOf(cls);
      for (const m of cls.methods) emit(m, scopeOf(m, members, cls.name));
    }
  }
  return out;
}
