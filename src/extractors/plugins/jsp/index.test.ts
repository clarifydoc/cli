import { describe, it, expect } from "vitest";
import { jspSpec } from "./index.js";

// Modelled on a Struts admin view: club: page/form taglib, grid actionLink,
// multi-line tag, plain-HTML anchor, includes, and a commented-out button.
const SAMPLE = `<%@ include file="../fragments/header.jsp" %>

<head>
    <title>Account applications</title>
</head>

<club:page labelKey="league.jsp.accountapplication_list.header">
    <grid_extjs:controller id="applications" entityListDescriptor="\${applications}">
        <grid:column name="action.details" labelKey="league.misc.action.details">
            <grid:actionLink cssClass="actionLink details" event="details" title="Details">
                <grid:actionParam name="applicationId" value="\${ref.id}"/>
            </grid:actionLink>
        </grid:column>
        <grid:column name="civicNo" labelKey="league.jsp.accountapplication_list.applicant"/>
    </grid_extjs:controller>
    <!-- <club:button event="ghost" labelKey="commented.out"/> -->
    <club:form>
        <club:textBox bindPath="model.notes" cols="50" labelKey="league.dmo.accountapplication.notes"/>
        <club:buttonGroup>
            <club:button cssClass="approveButton" event="approveAll"
                        labelKey="league.jsp.accountapplication_list.approveselected"/>
            <club:button cssClass="rejectButton" event="rejectAll" labelKey="league.jsp.accountapplication_list.rejectselected"/>
        </club:buttonGroup>
    </club:form>
    <a href="other.jsp" onclick="openHelp()">Help</a>
    <jsp:include page="footer.jsp"/>
</club:page>`;

const lines = SAMPLE.split("\n");

describe("jspSpec interactive elements", () => {
  const els = jspSpec.extractInteractiveElements!(lines);

  it("extracts taglib event tags with the event as handler", () => {
    const approve = els.find((e) => e.handler === "approveAll")!;
    expect(approve).toBeDefined();
    expect(approve.element).toBe("button");
    expect(approve.component).toBe("club:button");
    expect(els.some((e) => e.handler === "rejectAll")).toBe(true);
    const details = els.find((e) => e.handler === "details")!;
    expect(details.element).toBe("link");
  });

  it("extracts multi-line tags and skips commented-out ones", () => {
    // approveAll's tag spans two lines — line points at the opening.
    const approve = els.find((e) => e.handler === "approveAll")!;
    expect(approve.line).toBe(20);
    expect(els.some((e) => e.handler === "ghost")).toBe(false);
  });

  it("keeps bound inputs as handler-less elements", () => {
    const notes = els.find((e) => e.component === "club:textBox")!;
    expect(notes).toBeDefined();
    expect(notes.handler).toBeNull();
  });

  it("still extracts plain HTML controls", () => {
    expect(els.some((e) => e.element === "link" && e.handler === "openHelp")).toBe(true);
  });
});

describe("jspSpec screens", () => {
  const screens = jspSpec.extractScreens!(lines, "admin/src/main/webapp/WEB-INF/views/account/accountapplication_list.jsp", []);

  it("builds one screen per page with the taglib caption", () => {
    expect(screens).toHaveLength(1);
    expect(screens[0]!.name).toBe("accountapplication_list");
    expect(screens[0]!.caption).toBe("league.jsp.accountapplication_list.header");
    expect(screens[0]!.formType).toBe("jsp-view");
  });

  it("collects controls as screen components", () => {
    const comps = screens[0]!.components;
    const button = comps.find((c) => c.componentType === "club:button")!;
    expect(button.category).toBe("action");
    expect(button.events).toEqual(["approveAll"]);
    const bound = comps.find((c) => c.componentType === "club:textBox")!;
    expect(bound.category).toBe("input");
    expect(bound.dataBindings).toEqual(["model.notes"]);
  });
});

describe("jspSpec imports", () => {
  it("captures static and runtime includes", () => {
    const sources: string[] = [];
    for (const line of lines) {
      for (const p of jspSpec.importPatterns) {
        const m = line.match(p.pattern);
        if (m) sources.push(p.getSource(m));
      }
    }
    expect(sources).toContain("../fragments/header.jsp");
    expect(sources).toContain("footer.jsp");
  });
});
