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
    const a = view("app/views/players/edit.html.erb", `<% content_for :title, "Edit player" %>
<%= render 'form', player: @player %>
<%= render partial: 'shared/header' %>
<%= link_to 'Back', players_path %>
<%= button_to 'Delete', player_path(@player), method: :delete, class: "btn" %>
<%= form_with model: @player do |f| %>
  <button type="submit" onclick="track('save')">Save</button>
<% end %>
<%# link_to 'Hidden', secret_path %>`);
    expect(a.interactiveElements.map((e) => [e.element, e.event, e.handler, e.request?.method, e.request?.target])).toEqual([
      ["link", "click", "players_path", "GET", "players_path"],
      ["button", "click", "delete_player_path", "DELETE", "player_path"],
      ["form", "submit", "patch_player_path", "PATCH", "player_path"],
      ["button", "onclick", "track", undefined, undefined],
    ]);
    expect(a.subComponents.map((s) => [s.name, s.importSource])).toEqual([["form", "./_form.html"], ["header", "../shared/_header.html"]]);
    expect(a.screens[0]).toMatchObject({ name: "players#edit", formType: "RailsView", caption: "Edit player", navigatesTo: ["players_path"] });
  });

  it("posts a model form to the plural helper outside an edit view, and keeps partials and layouts off the screen list", () => {
    const form = view("app/views/players/_form.html.erb", `<%= form_for @player do |f| %><% end %>`);
    expect(form.interactiveElements[0]!.request).toEqual({ method: "POST", target: "players_path" });
    expect(form.screens).toEqual([]);
    expect(view("app/views/layouts/application.html.erb", `<%= yield %>`).screens).toEqual([]);
  });

  it("names a route helper the way Rails does", () => {
    expect(railsRouteHelper("/players/:id/edit", "edit")).toBe("edit_player");
    expect(railsRouteHelper("/players/new", "new")).toBe("new_player");
    expect(railsRouteHelper("/players/:id", "show")).toBe("player");
    expect(railsRouteHelper("/players", "index")).toBe("players");
    expect(railsRouteHelper("/clubs/:club_id/conversations", "index")).toBe("club_conversations");
    expect(railsRouteHelper("/super_admin/clubs/:id/seed", "seed")).toBe("seed_super_admin_club");
    expect(railsRouteHelper("/staff/players/presence", "presence")).toBe("presence_staff_players");
  });

  it("links a view's handler to the controller action its route helper reaches, by verb", () => {
    const edit = view("app/views/players/edit.html.erb", `<%= button_to 'Delete', player_path(@player), method: :delete %>
<%= link_to 'Show', player_path(@player) %>
<%= form_with model: @player do |f| %><% end %>`);
    const route = (httpMethod: string, path: string, handler: string) => ({ httpMethod, path, handler, kind: "api", calls: [], middleware: [], line: 1 });
    const controller = {
      filePath: "app/controllers/players_controller.rb", language: "ruby", interactiveElements: [], routes: [
        route("GET", "/players/:id", "PlayersController#show"), route("PUT", "/players/:id", "PlayersController#update"), route("DELETE", "/players/:id", "PlayersController#destroy"),
      ],
      classes: [{ name: "PlayersController", methods: [{ name: "show", line: 5 }, { name: "update", line: 9 }, { name: "destroy", line: 14 }] }],
    } as unknown as FileAnalysis;
    const links = new RailsViewResolver().resolve([edit, controller]);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}:${l.targetLine}`)).toEqual([
      "delete_player_path -> PlayersController.destroy:14",
      "player_path -> PlayersController.show:5",
      "patch_player_path -> PlayersController.update:9",
    ]);
  });
});
