import { describe, it, expect } from "vitest";
import { jspSpec } from "./index.js";

// Modelled on a Struts admin view: club: page/form taglib, grid actionLink,
// multi-line tag, plain-HTML anchor, includes, and a commented-out button.
const SAMPLE = `<%@ include file="../fragments/header.jsp" %>

<head>
    <title>Club applications</title>
</head>

<club:page labelKey="league.jsp.clubapplication_list.header">
    <grid_table:controller id="applications" fixtureListDescriptor="\${applications}">
        <grid:column name="action.details" labelKey="league.misc.action.details">
            <grid:actionLink cssClass="actionLink details" event="details" title="Details">
                <grid:actionParam name="applicationId" value="\${ref.id}"/>
            </grid:actionLink>
        </grid:column>
        <grid:column name="shirtNo" labelKey="league.jsp.clubapplication_list.applicant"/>
    </grid_table:controller>
    <!-- <club:button event="ghost" labelKey="commented.out"/> -->
    <club:form>
        <club:textBox bindPath="model.notes" cols="50" labelKey="league.dmo.clubapplication.notes"/>
        <club:buttonGroup>
            <club:button cssClass="approveButton" event="approveSelected"
                        labelKey="league.jsp.clubapplication_list.approveselected"/>
            <club:button cssClass="rejectButton" event="rejectSelected" labelKey="league.jsp.clubapplication_list.rejectselected"/>
        </club:buttonGroup>
    </club:form>
    <a href="other.jsp" onclick="openHelp()">Help</a>
    <jsp:include page="footer.jsp"/>
</club:page>`;

const lines = SAMPLE.split("\n");

describe("jspSpec interactive elements", () => {
  const els = jspSpec.extractInteractiveElements!(lines);

  it("extracts taglib event tags with the event as handler", () => {
    const approve = els.find((e) => e.handler === "approveSelected")!;
    expect(approve).toBeDefined();
    expect(approve.element).toBe("button");
    expect(approve.component).toBe("club:button");
    expect(els.some((e) => e.handler === "rejectSelected")).toBe(true);
    const details = els.find((e) => e.handler === "details")!;
    expect(details.element).toBe("link");
  });

  it("extracts multi-line tags and skips commented-out ones", () => {
    // approveSelected's tag spans two lines — line points at the opening.
    const approve = els.find((e) => e.handler === "approveSelected")!;
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

describe("jspSpec Web Flow events fired from script", () => {
  it("reads an _eventId_ a listBox's onChange or a script sets as an element with that handler (real-repo FP)", () => {
    const page = [
      `<club:form>`,
      `  <club:listBox bindPath="model.season" onChange="this.form._eventId.name='_eventId_pickSeason';this.form.submit();"/>`,
      `</club:form>`,
      `<script>`,
      `  function mail() { submitEvent("_eventId_sendMail"); }`,
      `</script>`,
    ];
    const els = jspSpec.extractInteractiveElements!(page);
    expect(els.filter((e) => ["submit", "pickSeason", "sendMail"].includes(e.handler ?? "")).map((e) => `${e.line} ${e.element} ${e.event} ${e.handler}`)).toEqual([
      // The HTML reader's onChange element names the form's submit; the event it fires is its own element.
      "2 custom onchange submit",
      "2 select change pickSeason",
      "5 custom click sendMail",
    ]);
  });
});

describe("jspSpec screens", () => {
  const screens = jspSpec.extractScreens!(lines, "admin/src/main/webapp/WEB-INF/views/club/clubapplication_list.jsp", []);

  it("builds one screen per page with the taglib caption", () => {
    expect(screens).toHaveLength(1);
    expect(screens[0]!.name).toBe("clubapplication_list");
    expect(screens[0]!.caption).toBe("league.jsp.clubapplication_list.header");
    expect(screens[0]!.formType).toBe("jsp-view");
  });

  it("collects controls as screen components", () => {
    const comps = screens[0]!.components;
    const button = comps.find((c) => c.componentType === "club:button")!;
    expect(button.category).toBe("action");
    expect(button.events).toEqual(["approveSelected"]);
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

describe("JSP form and link requests", () => {
  it("hands form actions and action links to the route linker as calls in named pseudo-functions", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const src = `<%@ taglib prefix="html" uri="http://struts.apache.org/tags-html" %>
<form action="\${pageContext.request.contextPath}/club/save.do" method="post">
  <input type="submit" value="Save"/>
</form>
<html:form action="/club/delete">
</html:form>
<a href="<c:url value='/club/list.do'/>">List</a>
<a href="/static/help.html">Help</a>`;
    const a = extractWithRegex(src, "web/club/edit.jsp", "jsp");
    const reqs = a.interactiveElements.filter((e) => e.request).map((e) => `${e.element}@${e.line} ${e.handler} ${e.request!.method} ${e.request!.target}`);
    expect(reqs).toEqual([
      "form@2 post_club_save_do POST /club/save.do",
      "form@5 post_club_delete_do POST /club/delete.do",
      "link@7 club_list_do GET /club/list.do",
    ]);
    expect(a.dataSources.map((d) => `${d.name}@${d.line}`)).toEqual(["POST /club/save.do@2", "POST /club/delete.do@5", "GET /club/list.do@7"]);
    expect(a.functions.map((f) => f.name)).toEqual(expect.arrayContaining(["post_club_save_do", "club_list_do"]));
  });
});
