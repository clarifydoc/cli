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
