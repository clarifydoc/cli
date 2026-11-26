# Terraform plugin

Reads `.tf` with a regex front end (`RegexLangSpec`); `routes.ts`, `tfvars.ts` and `package-manifests.ts` hold its readers. Deployment topology is read by core ([deployment-terraform.ts](../../../core/deployment-terraform.ts)).

## Routes and tables

- An `aws_lambda_function`'s `environment { variables }` (a literal, or `aws_dynamodb_table.x.name|id` of a table whose `name` is a literal) gives a code row's `envRef` its value through this plugin's route resolver, on the module its handler names only (no provider-wide scope). A variable-built name stays unset.

## Config keys

- A `variable "x"` block is `FileAnalysis.configKeyReads` (spec `extractConfigKeyReads`), never a data source; core joins it to the `*.tfvars` in its own directory.
- `*.tfvars` files are a `serviceConfig.sources` entry ([tfvars.ts](tfvars.ts)) with `keysOnly: true`: names only, and no call origin may read them.

## Packages

- Terraform registry module sources are listed as `terraform` packages (`plugins/terraform/package-manifests.ts`).

## Deployment topology (core)

- Terraform modules give Lambdas, queues, tables, databases and the edges a module states. `./` module sources are followed: `var.x` (every caller must agree, else the default), `local.x` and `module.m.out` resolve to the resources they name, so edges cross module directories.
- A `module` whose source is a well-known registry module (`REGISTRY_MODULES`: `terraform-aws-modules` sqs, sns, dynamodb-table, rds, lambda; short, hosted, GitHub or `git::` spelling) is the queue, table, database or function its inputs name (`name`, `identifier`, `function_name` / `handler` / `source_path`). (its `module.x.output` edges) `module.<label>.<output>` in a function's `environment_variables` or `event_source_mapping` is a bus or db edge. Another publisher's namesake and an unlisted module build nothing.
