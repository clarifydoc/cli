# SQL plugin

Reads `.sql`, `.ddl`, `.dml`, `.psql`, `.mysql`, `.tsql`, `.plsql`, `.pkb`, `.pks` and `.drift` with a regex front end (`RegexLangSpec`, `entities.ts`, `frameworks.ts`, `named-queries.ts`, `routine-dispatch.ts`, `dbt.ts`); a schema-format language (`schemaFormat`).

## Schema types

- Tables and views are data shapes, never types code constructs or calls: they stay out of the symbol linker's indexes, exports and type catalogs (`declaresSchemaTypes`). Functions (a stored procedure, a named query) stay link targets.
- Table, view, foreign-key and column names read `[\p{L}\p{M}\p{N}_]` with the `u` flag, so `CREATE TABLE 球员` is an entity and `SELECT * FROM 球员` a table access; keywords stay ASCII. Index, sequence, trigger and procedure names and aliases are still ASCII.
- The `sql` framework rule lives in this plugin's `frameworks.ts`.

## Migrations

- A SQL migration chain (Flyway `V2__x.sql`, numbered files, golang-migrate, Prisma `migration.sql`) is replayed in version order into the schema it ends with, by this plugin's `reconcileProject`, from per-file `FileAnalysis.schemaOps` ([entities.ts](entities.ts)).

## Named queries

- A SQL named query's `col = :name` filters are `DataSourceInfo.whereFields`; an argument given by name lands on the callee's parameter of that name (`CallArgOrigin.param`), the only kind of argument followed through a dispatch link (aiosql).

## Inline SQL in other languages

- Inline SQL in every plugin is read through one shared reader (`statementAccesses` in [../shared/sql-string-sources.ts](../shared/sql-string-sources.ts)); this plugin owns only `.sql` files.
