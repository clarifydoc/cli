# Protocol Buffers plugin

Reads `.proto` with a regex front end (`RegexLangSpec`, `request-schema.ts`); an API-contract language like OpenAPI and WSDL (`apiContract`).

## Rows

- Each `rpc` is a row at `POST /<pkg>.<Service>/<Method>`, handled by its name: the spec join finds the implementing method.
- A `google.api.http` binding is a second row at its REST path.
- Messages are classes for the request-schema pass.

## Stubs

- A call on a generated client stub becomes an api-call at the rpc row's own path when the `.proto` is in the analysis, else with its `contract`; the stub naming (`pb.NewOrderServiceClient(conn)`, `…_pb2_grpc.GreeterStub`, `OrderServiceGrpc.newBlockingStub`, `Greeter.GreeterClient`) is each language plugin's `grpcStubService`, consumed by core's [grpc-clients.ts](../../../core/grpc-clients.ts).
- Thrift rides the same hooks (see [../thrift/AGENTS.md](../thrift/AGENTS.md)).

## Handlers

- An rpc is served only by a class tied to its service — one that extends or implements protoc's generated base, which each language plugin's `grpcServiceOf` states. The manifest's `handlerByServiceTie` makes core join nothing else: `specRouteHandlerLink` stops after the tie (and after a code row serving the same contract), so a class that merely has a method of the rpc's name, or a test double, is never the handler, and `synthesizeApiRouteSymbolLinks` sends the client's edge to the handler the spec join found (else it ends on the row's own `route:` symbol) instead of resolving the rpc's bare name project-wide.
- A class only registered with the service (`add_XServicer_to_server(Referee(), s)`, Go `RegisterXServer(s, &referee{})` without the embedded `Unimplemented…`) is not read as a tie yet: such an rpc has no handler link (before, a unique namesake got one).
