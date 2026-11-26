# OpenAPI plugin (incl. AsyncAPI)

Reads OpenAPI documents in `.yaml`, `.yml` and `.json` with a regex front end (`RegexLangSpec`, [request-schema.ts](request-schema.ts) for the request-schema hooks); an API-contract language (`apiContract`).

- OpenAPI owns `.yml` / `.yaml` / `.json`, so it refuses foreign files from `preprocess` with `{ skip }`. Other formats that share the extensions are branches of this `preprocess` (AsyncAPI, [asyncapi.ts](asyncapi.ts)); serverless descriptors are claimed by name instead (see [../serverless/AGENTS.md](../serverless/AGENTS.md)).
- [index.ts](index.ts) — contract rows, schemas as entities (`origin: "contract"`), the attribute layer. Read its header before changing how a contract row meets code.
- [asyncapi.ts](asyncapi.ts) — channel operations as `queue-publish` / `queue-consume` rows in `FileAnalysis.busContracts`; payloads become `openapi` classes for the request-schema pass.
