# GraphQL plugin

Reads `.graphql`, `.gql` and `.graphqls` with a regex front end (`RegexLangSpec`); an API-contract language (`apiContract`).

## Schema files

- A schema gives routes and entities through [../shared/graphql-sdl.ts](../shared/graphql-sdl.ts). Spring's `.graphqls` beside its resolvers is read the same way.
- A schema's classes are data shapes (`declaresSchemaTypes`): they stay out of the symbol linker's indexes and type catalogs.

## Operation documents

- An operation document a client keeps beside its code (`query GetUser { user(id: 1) { … } }`) gives one api-call per root field, as an inline `gql` template does (`extractGqlDocumentCalls`, [../shared/graphql-operations.ts](../shared/graphql-operations.ts)).
- The call's column is the operation keyword's column.
