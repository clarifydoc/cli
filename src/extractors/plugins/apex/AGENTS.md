# Apex plugin

Reads Salesforce Apex (`.cls`, `.trigger`) and SFDX metadata with a regex `RegexLangSpec`: case-insensitive names, `family: apex`. Aura and Visualforce markup is a separate plugin, [../sfmarkup/AGENTS.md](../sfmarkup/AGENTS.md); Lightning Web Components are read by the JavaScript plugin ([../javascript/AGENTS.md](../javascript/AGENTS.md)).

## Files this plugin takes

- `.trigger` is the plugin's own extension; `.cls` is VB6's and `.xml` is Spring XML's. The manifest's `adoptsSuffixes` (`.cls`, `*.object-meta.xml`, `*.field-meta.xml`) and the meta's `adopt` take an Apex class or SFDX metadata: the registry's `preprocessFile` asks the adopting plugin before the owner's `preprocess`, in the analyzer and in discovery's skip check. No plugin imports another.
- `sfdx-project.json` is the `salesforce` sub-project marker.

## Structure

- Inner classes are classes of their own; each method belongs to the innermost.
- Annotations are decorators with their arguments.
- `@RestResource(urlMapping)` + `@HttpGet`… are routes under `/services/apexrest`, a whole `*` segment spelled `{wildcard}`.
- `trigger X on Club__c (…)` is a function carrying `Trigger(Club__c; …)`.
- A property whose `get` has a body is a getter method of its own (`public List<Club__c> clubs { get { return [SELECT …]; } }`); a Visualforce read `{!clubs}` joins it and its queries are its own. An auto-property (`get;`) has nothing to reach.

## SOQL, DML and callouts ([soql.ts](./soql.ts))

- The structure text blanks comments, inline SOQL and string braces; SOQL, DML and `HttpRequest` callouts are read from the data text.
- SOQL reads: `[SELECT … FROM Club__c]`, a string that is a whole query (pieces joined across `+`), SOSL `RETURNING`. A relationship subquery is never an object.
- `insert`/`update`/`upsert`/`delete`/`undelete`/`merge` and `Database.*` write the SObject type the operand DECLARES (a local, parameter, field, `new`, `map.values()`, a query): a custom `__c`/`__mdt`/`__e` suffix or a listed standard object, never a name guess.
- `req.setEndpoint('callout:League/…')` + `setMethod` on the same variable is an api-call with the Named Credential as its external `baseRef`.
- A subquery `(SELECT Id FROM Players__r)` is a row with `DataSourceInfo.viaRelationship`; `reconcileProject` resolves it through the lookup field declaring that `relationshipName` (`EntityRelation.inverseField`, `Players__r`) and, on a standard object, the platform's own child relationships (`Account.Contacts` → `Contact`, `Opportunity.OpportunityLineItems`), and drops it when none does.

## SObjects as entities

- SObjects are entities from SFDX metadata: a field file is a `sobject-fields` fragment gathered onto its object by `SalesforceEntityExtractor.reconcileProject`; a Lookup/MasterDetail `referenceTo` is a many-to-one relation; a standard object is an entity only where the project gives it a file or fields.

## Dead code ([reachability.ts](./reachability.ts))

- Apex has no imports: a class reaches another by being spelled in reachable text, case-folded (`ReachabilityModel.foldNames`).
- Entries: triggers, `@RestResource`/`@Http*`, `@AuraEnabled`/`@InvocableMethod`/`@RemoteAction`/`webservice` methods, `Schedulable`/`Database.Batchable`/`Queueable`/inbound-email/auth-handler classes, and a class a flow, Aura bundle, Visualforce page or custom-metadata record names.
- Passive: tests, `global` types, `Callable` implementations, and source outside every `packageDirectories` path of `sfdx-project.json`.
- `Type.forName('Prefix_' + x)` keeps the classes starting with the literal; a name with none keeps the classes that extend or implement a type — never from test code or a `'List<' + x` generic.

## Cross-language links

- A Lightning Web Component's `@salesforce/apex/Class.method` import — called or `@wire`d (a `<setup>` call) — links to the Apex method through the manifest's `foreignImportTarget`, the one link that crosses language families: by a type and member another language's files declare, a bare call only, one declaring file only ([../javascript/apex-imports.ts](../javascript/apex-imports.ts), `foreignImportMember`).
- An Aura component's action links to the `@AuraEnabled` method of the class its `controller=` names (one declaring file only), and a Visualforce action or read links to the method on `extensions=` first, then the controller — see [../sfmarkup/AGENTS.md](../sfmarkup/AGENTS.md).
