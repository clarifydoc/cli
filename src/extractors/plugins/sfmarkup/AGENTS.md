# Salesforce markup plugin (`sfmarkup`)

Reads Aura components and Visualforce pages: `.cmp`, `.app`, `.page`, `.component`. The Apex classes they call are [../apex/AGENTS.md](../apex/AGENTS.md); the Aura controller, helper and renderer JavaScript is read by the JavaScript plugin ([../javascript/AGENTS.md](../javascript/AGENTS.md)).

## Files

- `preprocess` refuses a file unless it opens an `aura:` or `apex:` root tag, so another framework's `.component` stays unread.

## What the markup states

- The markup is a screen whose `viewModel` is its `controller=`.
- `{!c.handleSave}` on any attribute and `action="{!save}"` are interactive-element handlers.
- The controller and `extensions=` ride the file's `<setup>` as `Controller(X)` / `Extension(Y)` decorators.
- A page's expression reads (`{!clubs}`: the head of the path, never a function, literal, global or `var=` name) are `<setup>` calls to `vf-binding:<name>`.

## Facts the JavaScript plugin states for it

The plugin reads `aura/<n>/<n>Controller|Helper|Renderer.js` as `var <n>Controller = { … }` (the parenthesised object swapped for a declaration, lines kept: [../javascript/aura-controllers.ts](../javascript/aura-controllers.ts)) and states these calls, which no name tier guesses:

- `component.get("c.saveClub")` → a call to `aura-action:saveClub`.
- `component.getEvent("clubSelected")` → `aura-event:clubSelected`.
- `$A.get("e.c:leagueRefreshed")` → `aura-app-event:leagueRefreshed`.
- `helper.x` / the helper's `this.x` → `aura-helper:x`.

Below an `sfdx-project.json`'s `packageDirectories`, an LWC `lwc/<n>/<n>.js` and an Aura `aura/<n>/<n>{Controller,Helper,Renderer}.js` are passive for dead code (the platform loads them by folder name, they anchor no project, so an SFDX repository with no other JS entry stays unjudged); a stray file of the folder no import reaches keeps its finding.

## Resolver ([resolver.ts](./resolver.ts), `SfMarkupResolver`, `dispatch:sf-markup`)

- Markup → controller function.
- Controller / renderer → helper function.
- An action → the `@AuraEnabled` method of the class `controller=` names (one declaring file only).
- A fired component event → the handler each component rendering the firing one binds to it (`onclubSelected="{!c.picked}"` on its tag, or `<aura:handler name=…>`).
- An application event → every `<aura:handler event="c:x">`.
- A Visualforce action or read → the method (a read as `getX`) on the extensions first, then the controller. A getter with a body is reachable; an auto-property is not (see the Apex plugin).
