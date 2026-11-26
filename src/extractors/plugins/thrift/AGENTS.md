# Apache Thrift plugin

Reads `.thrift` with a regex front end (`RegexLangSpec`, `request-schema.ts`); an API-contract language like protobuf (`apiContract`).

## Rows and classes

- Each service method is a row at `POST /<java namespace>.<Service>/<method>`, handled by its name and carrying `contract`.
- `extends` is copied across files by a route resolver (`routeFacts`).
- Structs, unions, exceptions and enums are classes; `<Service>_<method>_args` is the body class.
- String literals are blanked before fields and methods are read: a default `"2: i32 fake"` is no field, and a lone quote never swallows the file.

## Generated stubs

- Stubs (`ClubService.Client`, Go `NewClubServiceClientFactory`) and `ClubService.Iface` implementors ride the gRPC hooks (`grpcStubService` / `grpcServiceOf`), composed in [../shared/thrift-stubs.ts](../shared/thrift-stubs.ts). A stub is certain only when the file imports the Thrift runtime, else only for a declared service.
- A Go stub TYPE (`ClubServiceClient`) counts only in a file importing the Thrift runtime or a package the project generated from a `.thrift` (a `gen-go/` path, or a package declaring `XClient` beside `XProcessor`). `core/grpc-clients.ts` hands the stub hook every analyzed file as a third argument, and `firstStub` prefers a certain answer.
- A Node client `thrift.createClient(ClubService, conn)` names its service in an argument: `grpc-clients.ts` asks the stub hook again with `createClient(ClubService)` when the bare spelling answers nothing. An awaited receiver (`(await connect()).createClient(ClubService)`) is read past.

## Handlers the generated code does not name

- Go `NewClubServiceProcessor(&clubHandler{})`, Python `ClubService.Processor(handler)` and Node `thrift.createServer(ClubService, handler)` are `thrift-handler` route facts ([../shared/thrift-handlers.ts](../shared/thrift-handlers.ts)), only in a file naming `thrift`.
- The `thrift-handlers` resolver joins them with the declared service's rpcs and the one class of the handler's type: each rpc the class has a method for becomes a contract row ON that method (the grpc-js `addService` shape), which the `.thrift` row's spec join finds.
- A handler held in a variable is read from its one literal or constructor assignment.
- An object-literal handler (`createServer(ClubService, { getClub() {…}, listClubs: async () => … })`, or a variable assigned one) serves the rpcs it has a member for: a held one on its `<holder>.<method>` functions, a literal written in the call on rows named `createServer.<method>`.

## Node handler objects

Read from the parse in [../javascript/contract-handlers.ts](../javascript/contract-handlers.ts), for thrift `createServer(ClubService, {…})` (and `createServer(Service, {…})`) and grpc-js `server.addService(X.service, {…})` alike.

- Each member is a function of its own, `createServer.<key>` / `addService.<key>` (a held function's style): the contract row sits on it, so its body's calls are attributed to it. A second call in one file reusing a key gets `@<line>` appended.
- A member that names a function (`getClub: someFn`, `getClub: clubs.getClub`, shorthand, `.bind(this)`) is that pseudo-function holding one `passed: "argument"` call of the name, which `resolvePassedName` resolves without guessing: a namesake in an unrelated file is never the handler. A call-result value (`getClub: makeHandler()`), a spread or an accessor is no handler.
- A member's value is read through parentheses, `as` / `<T>` / `satisfies` assertions and `!`.
- A `this.x.bind(this)` member is the method `x` of the class the object is written in (the call names `Class.x`, so the linker resolves it on that class, never a namesake).
- An object first held in a file's one `const|let|var name = {…}` gives `<name>.<key>` functions (a member already a function of that name is not made twice). A name declared twice, or an object defined in another file, is not read.
