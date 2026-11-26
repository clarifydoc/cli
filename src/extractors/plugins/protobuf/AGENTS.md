# Protocol Buffers plugin

Reads `.proto` with a regex front end (`RegexLangSpec`, `request-schema.ts`); an API-contract language like OpenAPI and WSDL (`apiContract`).

## Rows

- Each `rpc` is a row at `POST /<pkg>.<Service>/<Method>`, handled by its name: the spec join finds the implementing method.
- A `google.api.http` binding is a second row at its REST path.
- Messages are classes for the request-schema pass.

## Stubs

- A call on a generated client stub becomes an api-call at the rpc row's own path when the `.proto` is in the analysis, else with its `contract`; the stub naming (`pb.NewOrderServiceClient(conn)`, `…_pb2_grpc.GreeterStub`, `OrderServiceGrpc.newBlockingStub`, `Greeter.GreeterClient`) is each language plugin's `grpcStubService`, consumed by core's [grpc-clients.ts](../../../core/grpc-clients.ts).
- Thrift rides the same hooks (see [../thrift/AGENTS.md](../thrift/AGENTS.md)).
