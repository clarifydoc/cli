# Terraform plugin

Reads `.tf` with a regex front end (`RegexLangSpec`); [routes.ts](routes.ts) (API Gateway routes on Lambda handlers, `envRef` values), [tfvars.ts](tfvars.ts) (`*.tfvars`, names only) and [package-manifests.ts](package-manifests.ts) (registry module sources are `terraform` packages) hold its readers. Deployment topology is read by core ([deployment-terraform.ts](../../../core/deployment-terraform.ts)).

## Deployment topology (core)

- Terraform modules give Lambdas, queues, tables, databases and the edges a module states. `./` module sources are followed: `var.x` (every caller must agree, else the default), `local.x` and `module.m.out` resolve to the resources they name, so edges cross module directories.
- A `module` whose source is a well-known registry module (`REGISTRY_MODULES`: `terraform-aws-modules` sqs, sns, dynamodb-table, rds, lambda; short, hosted, GitHub or `git::` spelling) is the queue, table, database or function its inputs name (`name`, `identifier`, `function_name` / `handler` / `source_path`), with its `module.x.output` edges: `module.<label>.<output>` in a function's `environment_variables` or `event_source_mapping` is a bus or db edge. Another publisher's namesake and an unlisted module build nothing.
