# Serverless plugin

Reads serverless descriptors with a regex front end (`RegexLangSpec`); it has no extensions of its own. Files are claimed by name through the manifest's `namedFiles` (`serverless.yml`, `serverless.yaml`, `template.yaml`, `template.yml`, `function.json`), because `.yml` / `.yaml` belong to OpenAPI.

## Routes

- `serverless.yml` http / httpApi events and SAM `template.yaml` Api / HttpApi events become routes.
- The plugin's route resolver (`route-anchor.ts`) moves each route onto the function its handler names: a module export beside the descriptor, or a JVM/.NET `Class::method`. The lookup is [../shared/lambda-handlers.ts](../shared/lambda-handlers.ts), shared with the JS plugin's AWS CDK reader (`RestApi` / `HttpApi` wiring as `cdk:route` facts, [../javascript/routes/cdk.ts](../javascript/routes/cdk.ts)).
- A `${opt:stage, self:provider.stage}` stage with a stated default takes it in every name of the descriptor, so an env table name (`${self:service}-${opt:stage, …}`) resolves.

## Azure Functions and Dapr

- `function.json` (the v1-v3 Azure Functions model: one folder per function, its trigger and `scriptFile`) is read by `function-json.ts`.
- A Dapr `kind: Subscription` YAML is a route on the path it names (`dapr.ts`); the SDK publish and subscribe calls are read by the language plugins.

## Tables named by an environment variable

- `environment.ts` reads each descriptor's `environment` (`provider.environment`, a function's own, SAM `Globals.Function.Environment.Variables` and the function's) into `lambda-env` route facts. Read: literals, `${self:…}` from the same file, and `Ref` to a DynamoDB table resource (its `TableName`, else its logical id). Left out: `${opt:…}`, `${ssm:…}`, `!Sub` pseudo parameters and parameter `Ref`s.
- The route resolver's `applyEnvironment` gives a code row's `DataSourceInfo.envRef` (an env name with no target, stated by the JS DynamoDB reader) its value: provider-wide for any code file below the descriptor's directory, a function's own for the module its handler names (which wins). A variable another service's descriptor sets, or that two descriptors / functions of one module set differently, stays unset.
- Core then drops every row still carrying `envRef`: a table is never guessed.
- A receiver the file builds from the DynamoDB SDK (`new AWS.DynamoDB.DocumentClient()`) is never a request receiver.

## Dead code

- A handler a descriptor routed onto anchors reachability (`resolvedBy: serverless-handler-anchor`, or `entryPoints` with framework `sam` / `serverless`).
