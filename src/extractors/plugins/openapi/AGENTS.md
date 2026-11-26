# OpenAPI plugin (incl. AsyncAPI)

Reads OpenAPI documents in `.yaml`, `.yml` and `.json` with a regex front end (`RegexLangSpec`, `request-schema.ts` for the request-schema hooks); an API-contract language (`apiContract`).

## Ownership

- OpenAPI owns `.yml` / `.yaml` / `.json`, so it refuses foreign files from `preprocess` with `{ skip }`.
- Other formats that share the extensions are branches of this `preprocess`, not second plugins: AsyncAPI here; serverless descriptors are claimed by name instead (see [../serverless/AGENTS.md](../serverless/AGENTS.md)).

## Contract rows

- Rows are API-contract rows (`manifest.apiContract`): a row yields to the code row implementing it (`pairContractTwins`: same method + path, or the symbol linker's spec join). A contract row exactly one production code route serves joins its handler by operation id only, never by a name derived from its path (a client wrapper `deleteClubs` is no implementation).
- A schema an API contract declares is an entity with `origin: "contract"`, listed apart in the data model, and never covers a same-named table.
- Contract schemas and messages are `declaresSchemaTypes` classes: no linker strategy lands on them, so a bare `update` never reaches an OpenAPI fragment `update.yml`.
- Swagger Codegen / OpenAPI Generator classes are generated code, so their calls' links carry `sourceRole: generated`.

## AsyncAPI 2.x / 3.x

- A document is recognised by an `asyncapi:` root key, checked after the OpenAPI sniff, and handed to `openapi/asyncapi.ts` ([asyncapi.ts](asyncapi.ts)).
- Each channel operation becomes a `queue-publish` / `queue-consume` row with `DataSourceInfo.fromContract`, kept in `FileAnalysis.busContracts`, never `dataSources`: the document is no publisher or consumer.
- Direction: 2.x `publish` = the application receives (consume), `subscribe` = it sends (publish); 3.x `action: receive|send`.
- The broker comes from `servers[].protocol` (`brokerOfProtocol`); a channel's `servers` narrows it and several protocols give a row each.
- The address is the channel name or 3.x `address`. A `{param}` is a hole; an MQTT hole is `+`; the queue node's id reads every `${x}` / `{x}` hole as `*`, so the document and the code's templated destination meet on one node.
- `buildDataAccessGraph` creates the node `queue::<broker>::<address>`, marks it `contract`, and marks it `unimplemented` when no code row meets it. The document draws no edge. `element-registry.ts` carries both flags through the summary.
- Payloads: `components.schemas` and each message with an inline `payload` become `openapi` classes for the request-schema pass.
