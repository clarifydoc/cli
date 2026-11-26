# Salesforce markup plugin (`sfmarkup`)

Reads Aura components and Visualforce pages: `.cmp`, `.app`, `.page`, `.component`. The Apex classes they call are [../apex/AGENTS.md](../apex/AGENTS.md); the Aura controller, helper and renderer JavaScript is read by the JavaScript plugin ([../javascript/AGENTS.md](../javascript/AGENTS.md)).

## Map

- [preprocess.ts](preprocess.ts) — refuses a file unless it opens an `aura:` or `apex:` root tag, so another framework's `.component` stays unread.
- [index.ts](index.ts) — what the markup states: the screen (`viewModel` is its `controller=`), handlers, `Controller(X)` / `Extension(Y)` decorators on `<setup>`, `vf-binding:<name>` expression reads.
- [resolver.ts](resolver.ts) — `SfMarkupResolver` (`dispatch:sf-markup`): markup → controller, controller/renderer → helper, action → `@AuraEnabled` Apex method, component and application events → handlers, Visualforce reads → extensions then controller.

## Facts the JavaScript plugin states for it

It reads `aura/<n>/<n>Controller|Helper|Renderer.js` as `var <n>Controller = { … }` ([../javascript/aura-controllers.ts](../javascript/aura-controllers.ts)) and states calls no name tier guesses: `component.get("c.saveClub")` → `aura-action:saveClub`, `component.getEvent("clubSelected")` → `aura-event:clubSelected`, `$A.get("e.c:leagueRefreshed")` → `aura-app-event:leagueRefreshed`, `helper.x` → `aura-helper:x`. Keep the spellings equal on both sides.

Below an `sfdx-project.json`'s `packageDirectories`, an LWC `lwc/<n>/<n>.js` and an Aura `aura/<n>/<n>{Controller,Helper,Renderer}.js` are passive for dead code (the platform loads them by folder name, they anchor no project, so an SFDX repository with no other JS entry stays unjudged); a stray file of the folder no import reaches keeps its finding.
