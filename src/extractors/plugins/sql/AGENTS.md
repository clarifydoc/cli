# SQL plugin

Reads `.sql`, `.ddl`, `.dml`, `.psql`, `.mysql`, `.tsql`, `.plsql`, `.pkb`, `.pks` and `.drift` with a regex front end (`RegexLangSpec`); a schema-format language (`schemaFormat`).

- [index.ts](index.ts) — the spec: tables and views as data shapes (`declaresSchemaTypes`), Unicode names, routines. [frameworks.ts](frameworks.ts) holds the `sql` framework rule.
- [entities.ts](entities.ts) — migration chains (Flyway, numbered, golang-migrate, Prisma `migration.sql`) replayed in version order by this plugin's `reconcileProject`, from per-file `FileAnalysis.schemaOps`.
- [named-queries.ts](named-queries.ts) (`whereFields`, `CallArgOrigin.param`), [routine-dispatch.ts](routine-dispatch.ts), [dbt.ts](dbt.ts).
- Inline SQL in every other plugin is read through one shared reader (`statementAccesses` in [../shared/sql-string-sources.ts](../shared/sql-string-sources.ts)); this plugin owns only `.sql` files.
