import { describe, it, expect } from "vitest";
import { extractErbView } from "./index.js";
import { RailsViewResolver, railsRouteHelper } from "./rails-view-resolver.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const view = (filePath: string, source: string): FileAnalysis => {
  const a = { filePath, language: "erb", imports: [], interactiveElements: [], subComponents: [], screens: [] } as unknown as FileAnalysis;
  extractErbView(a, source);
  return a;
};

describe("ERB views", () => {
  it("reads forms, buttons, links and partials into elements with requests, imports and a screen", () => {
    const a = view("app/views/users/edit.html.erb", `<% content_for :title, "Edit user" %>
<%= render 'form', user: @user %>
<%= render partial: 'shared/header' %>
<%= link_to 'Back', users_path %>
<%= button_to 'Delete', user_path(@user), method: :delete, class: "btn" %>
<%= form_with model: @user do |f| %>
  <button type="submit" onclick="track('save')">Save</button>
<% end %>
<%# link_to 'Hidden', secret_path %>`);
    expect(a.interactiveElements.map((e) => [e.element, e.event, e.handler, e.request?.method, e.request?.target])).toEqual([
      ["link", "click", "users_path", "GET", "users_path"],
      ["button", "click", "delete_user_path", "DELETE", "user_path"],
      ["form", "submit", "patch_user_path", "PATCH", "user_path"],
      ["button", "onclick", "track", undefined, undefined],
    ]);
    expect(a.subComponents.map((s) => [s.name, s.importSource])).toEqual([["form", "./_form.html"], ["header", "../shared/_header.html"]]);
    expect(a.screens[0]).toMatchObject({ name: "users#edit", formType: "RailsView", caption: "Edit user", navigatesTo: ["users_path"] });
  });

  it("posts a model form to the plural helper outside an edit view, and keeps partials and layouts off the screen list", () => {
    const form = view("app/views/users/_form.html.erb", `<%= form_for @user do |f| %><% end %>`);
    expect(form.interactiveElements[0]!.request).toEqual({ method: "POST", target: "users_path" });
    expect(form.screens).toEqual([]);
    expect(view("app/views/layouts/application.html.erb", `<%= yield %>`).screens).toEqual([]);
  });

  it("names a route helper the way Rails does", () => {
    expect(railsRouteHelper("/users/:id/edit", "edit")).toBe("edit_user");
    expect(railsRouteHelper("/users/new", "new")).toBe("new_user");
    expect(railsRouteHelper("/users/:id", "show")).toBe("user");
    expect(railsRouteHelper("/users", "index")).toBe("users");
    expect(railsRouteHelper("/accounts/:account_id/conversations", "index")).toBe("account_conversations");
    expect(railsRouteHelper("/super_admin/accounts/:id/seed", "seed")).toBe("seed_super_admin_account");
    expect(railsRouteHelper("/staff/users/presence", "presence")).toBe("presence_staff_users");
  });

  it("links a view's handler to the controller action its route helper reaches, by verb", () => {
    const edit = view("app/views/users/edit.html.erb", `<%= button_to 'Delete', user_path(@user), method: :delete %>
<%= link_to 'Show', user_path(@user) %>
<%= form_with model: @user do |f| %><% end %>`);
    const route = (httpMethod: string, path: string, handler: string) => ({ httpMethod, path, handler, kind: "api", calls: [], middleware: [], line: 1 });
    const controller = {
      filePath: "app/controllers/users_controller.rb", language: "ruby", interactiveElements: [], routes: [
        route("GET", "/users/:id", "UsersController#show"), route("PUT", "/users/:id", "UsersController#update"), route("DELETE", "/users/:id", "UsersController#destroy"),
      ],
      classes: [{ name: "UsersController", methods: [{ name: "show", line: 5 }, { name: "update", line: 9 }, { name: "destroy", line: 14 }] }],
    } as unknown as FileAnalysis;
    const links = new RailsViewResolver().resolve([edit, controller]);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}:${l.targetLine}`)).toEqual([
      "delete_user_path -> UsersController.destroy:14",
      "user_path -> UsersController.show:5",
      "patch_user_path -> UsersController.update:9",
    ]);
  });
});
