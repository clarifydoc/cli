import { describe, it, expect } from "vitest";
import { readHeex, heexSigils } from "./heex.js";
import { elixirSpec } from "./index.js";
import { heexSpec } from "../heex/index.js";
import { PhoenixEventResolver } from "./phoenix-event-resolver.js";
import type { FileAnalysis } from "../../../types/analysis.js";

describe("HEEx markup", () => {
  it("reads phx events, links with requests, forms and components", () => {
    const r = readHeex(`<h1>Sites</h1>
<button phx-click="pin-toggle" phx-value-domain={@site.domain}>Pin</button>
<.link navigate={~p"/#{@site.domain}/settings"}>Settings</.link>
<.link href={~p"/logout"} method="delete">Log out</.link>
<.form :let={f} for={@changeset} action={"/#{URI.encode_www_form(@site.domain)}/settings"}>
</.form>
<.form for={@form} phx-submit="save"></.form>
<.live_component module={PlausibleWeb.Live.Components.Modal} id="m" />
<PlausibleWeb.Components.Generic.toggle_switch id="t" />`);
    expect(r.elements.map((e) => [e.element, e.event, e.handler, e.request?.method, e.request?.target])).toEqual([
      ["button", "phx-click", "pin-toggle", undefined, undefined],
      ["link", "click", "x_settings", "GET", "/:param/settings"],
      ["link", "click", "delete_logout", "DELETE", "/logout"],
      ["form", "submit", "post_x_settings", "POST", "/:param/settings"],
      ["form", "phx-submit", "save", undefined, undefined],
    ]);
    expect(r.subComponents.map((s) => s.name)).toEqual(["PlausibleWeb.Live.Components.Modal", "PlausibleWeb.Components.Generic.toggle_switch"]);
    expect(r.caption).toBe("Sites");
  });

  it("finds ~H sigils, names handle_event clauses by event, and makes a LiveView a screen", () => {
    const lines = `defmodule PlausibleWeb.Live.Sites do
  use PlausibleWeb, :live_view

  def render(assigns) do
    ~H"""
    <button phx-click="pin-toggle">Pin</button>
    """
  end

  def handle_event("pin-toggle", %{"domain" => domain}, socket) do
    {:noreply, Sites.toggle_pin(domain)}
  end

  def handle_event("filter", params, socket) do
    {:noreply, socket}
  end
end`.split("\n");
    expect(heexSigils(lines).map((s) => s.firstLine)).toEqual([6]);
    const classes = elixirSpec.postProcessClasses!(lines, elixirSpec.extractClasses!(lines, []));
    expect(classes[0]!.methods.map((m) => m.name)).toEqual(["render", 'handle_event("pin-toggle")', 'handle_event("filter")']);
    const elements = elixirSpec.extractInteractiveElements!(lines);
    expect(elements).toEqual([expect.objectContaining({ handler: "pin-toggle", line: 6 })]);
    expect(elixirSpec.extractScreens!(lines, "lib/plausible_web/live/sites.ex", classes)[0]).toMatchObject({ name: "PlausibleWeb.Live.Sites", formType: "LiveView" });

    const live = { filePath: "lib/plausible_web/live/sites.ex", language: "elixir", classes, interactiveElements: elements, routes: [] } as unknown as FileAnalysis;
    const links = new PhoenixEventResolver().resolve([live]);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}:${l.targetLine}`)).toEqual([
      'pin-toggle -> PlausibleWeb.Live.Sites.handle_event("pin-toggle"):10',
    ]);
  });

  it("makes a controller template a screen and joins its form to the controller action through the router", () => {
    const tpl = `<.form for={@changeset} action={~p"/sites/#{@site.domain}/settings"} method="put"></.form>`.split("\n");
    expect(heexSpec.extractScreens!(tpl, "lib/plausible_web/templates/site/settings_general.html.heex", [])[0]!.name).toBe("site#settings_general");
    const template = { filePath: "lib/plausible_web/templates/site/settings_general.html.heex", language: "heex", classes: [], routes: [], interactiveElements: heexSpec.extractInteractiveElements!(tpl) } as unknown as FileAnalysis;
    const router = { filePath: "lib/plausible_web/router.ex", language: "elixir", classes: [], interactiveElements: [], routes: [
      { path: "/sites/:domain/settings", httpMethod: "PUT", kind: "api", handler: "SiteController.update_settings", calls: [], middleware: [], line: 3 },
    ] } as unknown as FileAnalysis;
    const controller = { filePath: "lib/plausible_web/controllers/site_controller.ex", language: "elixir", interactiveElements: [], routes: [],
      classes: [{ name: "PlausibleWeb.SiteController", line: 1, endLine: 40, methods: [{ name: "update_settings", line: 12 }] }] } as unknown as FileAnalysis;
    const links = new PhoenixEventResolver().resolve([template, router, controller]);
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`)).toEqual(["put_sites_x_settings -> PlausibleWeb.SiteController.update_settings"]);
  });
});
