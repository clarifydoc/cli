# Prisma plugin

Reads `.prisma` schemas with a regex front end (`RegexLangSpec`); a schema-format language (`schemaFormat`), with `frameworks.ts` and `migration-files.ts`.

## Schema types

- Models are data shapes, never types code constructs or calls: they stay out of the symbol linker's indexes, exports and type catalogs (`declaresSchemaTypes`).

## Framework rule

- The `prisma` framework rule lives in this plugin's `frameworks.ts`, because it owns the file format.

## Migrations

- A Prisma `migration.sql` belongs to a migration chain replayed in version order by the SQL plugin's `reconcileProject` (see [../sql/AGENTS.md](../sql/AGENTS.md)).
