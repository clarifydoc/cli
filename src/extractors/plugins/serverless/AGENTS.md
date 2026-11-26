# Serverless plugin

Reads serverless descriptors with a regex front end (`RegexLangSpec`); it has no extensions of its own. Files are claimed by name through the manifest's `namedFiles` (`serverless.yml`, `serverless.yaml`, `template.yaml`, `template.yml`, `function.json`), because `.yml` / `.yaml` belong to OpenAPI.

- [index.ts](index.ts) — `serverless.yml` http / httpApi events and SAM Api / HttpApi events become routes; `${opt:stage, self:provider.stage}` takes its stated default in every name of the descriptor.
- [route-anchor.ts](route-anchor.ts) — the route resolver moving each route onto the function its handler names; the lookup is [../shared/lambda-handlers.ts](../shared/lambda-handlers.ts), shared with the JS plugin's AWS CDK reader (`RestApi` / `HttpApi` wiring as `cdk:route` facts, [../javascript/routes/cdk.ts](../javascript/routes/cdk.ts)). Its `applyEnvironment` gives a code row's `DataSourceInfo.envRef` the value [environment.ts](environment.ts) read (`lambda-env` route facts).
- [function-json.ts](function-json.ts) — Azure Functions v1-v3; [dapr.ts](dapr.ts) — a `kind: Subscription` YAML is a route on the path it names (the SDK calls are read by the language plugins).
- A receiver the file builds from the DynamoDB SDK (`new AWS.DynamoDB.DocumentClient()`) is never a request receiver.
