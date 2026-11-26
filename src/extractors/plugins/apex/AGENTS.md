# Apex plugin

Reads Salesforce Apex (`.cls`, `.trigger`) and SFDX metadata with a regex `RegexLangSpec`: case-insensitive names, `family: apex`. Aura and Visualforce markup is a separate plugin, [../sfmarkup/AGENTS.md](../sfmarkup/AGENTS.md); Lightning Web Components are read by the JavaScript plugin ([../javascript/AGENTS.md](../javascript/AGENTS.md)).

## Map

- [manifest.ts](manifest.ts) — `.trigger` is the plugin's own extension; `.cls` (VB6's) and the `*-meta.xml` files are taken through `adoptsSuffixes` + the meta's `adopt`; `sfdx-project.json` is the `salesforce` sub-project marker.
- [index.ts](index.ts), [patterns.ts](patterns.ts) — structure: classes, inner classes, annotations as decorators, triggers, property getters. [source.ts](source.ts) builds the structure text and the data text; [preprocess.ts](preprocess.ts) wires them.
- [soql.ts](soql.ts) — SOQL, SOSL, DML and `HttpRequest` callouts, read from the data text.
- [routes.ts](routes.ts) — `@RestResource` + `@Http*` routes under `/services/apexrest`.
- [entities.ts](entities.ts) — SObjects from SFDX metadata (`SalesforceEntityExtractor.reconcileProject`).
- [reachability.ts](reachability.ts) — dead code by name (`ReachabilityModel.foldNames`), with the platform's entry points.

## Rules

- The structure text blanks comments, inline SOQL and string braces; data access is read only from the data text. A name is never read as a type: DML writes the SObject type its operand declares, never a name guess.
- A property whose `get` has a body is a getter method of its own (a Visualforce read `{!clubs}` joins it); an auto-property has nothing to reach.

## Cross-language links

- A Lightning Web Component's `@salesforce/apex/Class.method` import — called or `@wire`d (a `<setup>` call) — links to the Apex method through the manifest's `foreignImportTarget`, the one link that crosses language families: by a type and member another language's files declare, a bare call only, one declaring file only ([../javascript/apex-imports.ts](../javascript/apex-imports.ts), `foreignImportMember`).
- An Aura component's action links to the `@AuraEnabled` method of the class its `controller=` names, and a Visualforce action or read to the method on `extensions=` first, then the controller — see [../sfmarkup/AGENTS.md](../sfmarkup/AGENTS.md).
