import { describe, it, expect } from "vitest";
import { readTemplate } from "./index.js";
import { RazorTargetResolver } from "./razor-target-resolver.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const analysis = (filePath: string, language: string): FileAnalysis =>
  ({ filePath, language, functions: [], classes: [], dataSources: [], imports: [], interactiveElements: [], subComponents: [], screens: [] } as unknown as FileAnalysis);

describe("server templates", () => {
  it("reads a Handlebars admin page: partials, a form posting a literal path materialized as an api-call", () => {
    const a = analysis("src/static/templates/admin/login.hbs", "handlebars");
    readTemplate(a, `<title>Vaultwarden Admin</title>
{{> header}}
<form class="form-inline" method="post" action="{{urlpath}}/admin">
  <input type="password" name="token">
  <button type="submit">Enter</button>
</form>`, "handlebars");
    expect(a.subComponents.map((s) => s.name)).toEqual(["header"]);
    expect(a.interactiveElements.find((e) => e.element === "form")).toMatchObject({ handler: "post_admin", request: { method: "POST", target: "/admin" } });
    expect(a.dataSources).toEqual([{ kind: "api-call", name: "POST /admin", target: "/admin", calls: [], line: 3 }]);
    expect(a.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([["post_admin", 3, 3]]);
    expect(a.screens[0]).toMatchObject({ formType: "HandlebarsTemplate", caption: "Vaultwarden Admin" });
  });

  it("reads a FreeMarker login page: includes, its controls, and a form posting to a model-supplied URL as no app path", () => {
    const a = analysis("themes/league/login/kickoff-login.ftl", "freemarker");
    readTemplate(a, `<#import "template.ftl" as layout>
<#include "header.ftl">
<@layout.registrationLayout displayInfo=true; section>
  <#if section = "form">
    <form id="kickoff-login" action="\${url.loginAction}" method="post">
      <input type="text" name="username" value="\${(login.username!'')}">
      <button type="submit" name="login">\${msg("doLogIn")}</button>
    </form>
    <a href="/clubs/register">Register a club</a>
  </#if>
</@layout.registrationLayout>`, "freemarker");
    expect(a.subComponents.map((s) => s.name)).toEqual(["template", "header"]);
    expect(a.interactiveElements.map((e) => `${e.element} ${e.request?.target ?? "-"}`)).toEqual(expect.arrayContaining(["link /clubs/register"]));
    expect(a.interactiveElements.some((e) => e.request?.target.includes("loginAction"))).toBe(false);
    expect(a.screens[0]).toMatchObject({ formType: "FreeMarkerTemplate" });
  });

  it("reads a Django template: {% url %} targets on forms, links and htmx, {% include %} partials", () => {
    const a = analysis("clubs/templates/clubs/detail.html", "html");
    readTemplate(a, `{% extends "base.html" %}
{% include "clubs/_header.html" %}
<form method="post" action="{% url 'clubs:edit' club.pk %}">{% csrf_token %}<button type="submit">Save</button></form>
<a href="{% url 'clubs:list' %}?page=2">All clubs</a>
<a href="{% url 'clubs:table' %}{% querystring sort='points' %}">Table</a>
<button hx-delete="{% url 'clubs:delete' club.pk %}">Delete</button>`, "django");
    expect(a.subComponents.map((s) => s.name)).toEqual(["_header"]);
    expect(a.interactiveElements.filter((e) => e.request).map((e) => `${e.handler} ${e.request!.method} ${e.request!.target}`)).toEqual([
      "post_clubs_edit POST route:clubs:edit",
      "clubs_list GET route:clubs:list",
      "clubs_table GET route:clubs:table",
      "delete_clubs_delete DELETE route:clubs:delete",
    ]);
    expect(a.dataSources).toEqual([]);
  });

  it("reads a Go html/template page: {{template}} partials, a form and links under {{AppSubUrl}}", () => {
    const a = analysis("templates/club/settings/profile.tmpl", "gotemplate");
    readTemplate(a, `{{template "base/head" .}}
<div class="club settings">
	{{template "club/settings/navbar" .}}
	<form class="ui form" action="{{AppSubUrl}}/club/settings" method="post">
		{{.CsrfTokenHtml}}
		<input name="name" value="{{.Club.Name}}">
		<button class="ui primary button">{{ctx.Locale.Tr "save"}}</button>
	</form>
	<a href="{{AppSubUrl}}/club/settings/players">Players</a>
	<a href="{{.Club.HomeLink}}/edit">Edit</a>
</div>
{{template "base/footer" .}}`, "gotemplate");
    expect(a.subComponents.map((s) => s.name)).toEqual(["head", "navbar", "footer"]);
    // A link relative to another page's own URL (`{{.Club.HomeLink}}/edit`) is no app path.
    expect(a.dataSources.map((d) => d.name).sort()).toEqual(["GET /club/settings/players", "POST /club/settings"]);
    expect(a.screens[0]).toMatchObject({ formType: "GoTemplate" });
  });

  it("keeps mail templates and partials off the screen list", () => {
    const mail = analysis("src/static/templates/email/welcome.html.hbs", "handlebars");
    readTemplate(mail, `<a href="{{url}}/#/login">Log in</a> <a href="{{url}}/identity/accounts/verify?t={{token}}">Verify</a>`, "handlebars");
    expect(mail.screens).toEqual([]);
    // A fragment route is the client app's, not a server request; a real path stays.
    expect(mail.interactiveElements.map((e) => e.request?.target)).toEqual(["/identity/accounts/verify"]);
    const liquid = analysis("app/views/mailers/x/_footer.liquid", "liquid");
    readTemplate(liquid, `{% render 'logo' %}`, "liquid");
    expect(liquid.subComponents.map((s) => s.name)).toEqual(["logo"]);
  });

  it("names Razor tag-helper targets and joins them to the controller action by verb", () => {
    const view = analysis("Identity.API/Views/Account/Login.cshtml", "razor");
    readTemplate(view, `@model LoginViewModel
<partial name="_ValidationSummary" />
<form asp-route-returnUrl="@Model.ReturnUrl" method="post">
</form>
<form asp-action="Login" method="post"></form>
<a asp-controller="Home" asp-action="Index">Home</a>`, "razor");
    expect(view.interactiveElements.map((e) => [e.handler, e.request?.target])).toEqual([["post_Account_Login", "Account#Login"], ["Home_Index", "Home#Index"]]);
    expect(view.screens[0]).toMatchObject({ name: "Account#Login", formType: "RazorView" });
    const controller = { filePath: "Identity.API/Controllers/AccountController.cs", language: "csharp", interactiveElements: [], classes: [
      { name: "AccountController", methods: [{ name: "Login", line: 20, decorators: ["HttpGet"] }, { name: "Login", line: 40, decorators: ["HttpPost", "ValidateAntiForgeryToken"] }] },
    ] } as unknown as FileAnalysis;
    const links = new RazorTargetResolver().resolve([view, controller]);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}:${l.targetLine}`)).toEqual(["post_Account_Login -> AccountController.Login:40"]);
  });
});
