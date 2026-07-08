import { describe, it, expect } from "vitest";
import { qmlSpec } from "./index.js";
import {
  extractFunctionsWithSpec,
  extractImportsWithSpec,
} from "../shared/regex-base.js";

const SAMPLE = `
import QtQuick 2.12
import QtQuick.Controls 2.12
import "." as Skin
import "Theme"

Item {
    id: root

    property bool editMode: false
    signal toggleFocus

    function serializeModel(item) {
        let result = new Array();
        for (let i = 0; i < item.count; i++) {
            result.push(item.get(i));
        }
        return result;
    }

    Rectangle {
        id: background
        color: "#202020"
    }

    Skin.Button {
        id: playButton
        onClicked: root.play()
    }

    MouseArea {
        id: dragArea
        onDoubleClicked: {
            toggleMaximized();
        }
        onWidthChanged: recalc()
    }

    Component.onCompleted: {
        itemModel.append({});
    }

    Loader {
        id: dialogLoader
        source: "DeveloperToolsWindow.qml"
    }
}
`;

const lines = SAMPLE.split("\n");

describe("qmlSpec — imports & functions", () => {
  it("extracts module and local-directory imports", () => {
    const imports = extractImportsWithSpec(lines, qmlSpec);
    const sources = imports.map((i) => i.source);
    expect(sources).toContain("QtQuick");
    expect(sources).toContain("QtQuick.Controls");
    expect(sources).toContain(".");
    expect(sources).toContain("Theme");
    const skin = imports.find((i) => i.source === ".");
    expect(skin!.specifiers).toEqual(["Skin"]);
  });

  it("extracts inline JS functions", () => {
    const fns = extractFunctionsWithSpec(lines, qmlSpec);
    expect(fns.map((f) => f.name)).toEqual(["serializeModel"]);
  });
});

describe("qmlSpec — component structure", () => {
  it("collects child component usages (deduped leaf tags), not the root", () => {
    const subs = qmlSpec.extractSubComponents!(lines);
    const names = subs.map((s) => s.name);
    expect(names).toContain("Rectangle");
    expect(names).toContain("Button"); // Skin.Button → leaf
    expect(names).toContain("MouseArea");
    expect(names).toContain("Loader");
    expect(names).not.toContain("Item"); // the root IS this file's component
  });

  it("emits interaction handlers, not property-change or lifecycle handlers", () => {
    const els = qmlSpec.extractInteractiveElements!(lines);
    expect(els).toHaveLength(2);
    const byEvent = Object.fromEntries(els.map((e) => [e.event, e]));
    expect(byEvent["clicked"]).toMatchObject({
      element: "button",
      handler: "play",
      component: "Button",
    });
    expect(byEvent["doubleClicked"]).toMatchObject({
      element: "button",
      handler: "toggleMaximized",
      component: "MouseArea",
    });
    // onWidthChanged (property spam) and Component.onCompleted (lifecycle) excluded.
    expect(els.some((e) => e.event.toLowerCase().includes("width"))).toBe(false);
    expect(els.some((e) => e.event.toLowerCase().includes("completed"))).toBe(false);
  });

  it("extracts handlers from CRLF sources (Windows checkouts)", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n").split("\n");
    const els = qmlSpec.extractInteractiveElements!(crlf);
    expect(els.map((e) => e.event).sort()).toEqual(["clicked", "doubleClicked"]);
  });

  it("builds one screen per file with the component tree and qml navigation", () => {
    const screens = qmlSpec.extractScreens!(lines, "res/qml/Deck.qml", []);
    expect(screens).toHaveLength(1);
    const s = screens[0]!;
    expect(s.name).toBe("Deck");
    expect(s.formType).toBe("Item");
    expect(s.navigatesTo).toEqual(["DeveloperToolsWindow.qml"]);
    const types = s.components.map((c) => c.componentType);
    expect(types).toEqual(["Rectangle", "Skin.Button", "MouseArea", "Loader"]);
    const play = s.components.find((c) => c.name === "playButton")!;
    expect(play.category).toBe("action");
    expect(play.events).toContain("onClicked");
  });
});
