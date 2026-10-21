import { describe, it, expect } from "vitest";
import { springxmlSpec, parseFlow, flowIdOf } from "./index.js";
import { springxmlMeta } from "./meta.js";
import { WebflowUiBridgeResolver } from "./dispatch.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";

// Trimmed from a real Spring Web Flow: view-state with transitions, action-states
// with evaluates, a subflow, a decision-state and an end-state.
const FLOW = `<?xml version="1.0" encoding="UTF-8"?>
<flow xmlns="http://www.springframework.org/schema/webflow"
      xsi:schemaLocation="http://www.springframework.org/schema/webflow/spring-webflow-2.0.xsd"
      start-state="setup">
   <secured attributes="ROLE_CLUBS, ROLE_ADMIN" match="any"/>
   <input name="applicationId" value="flowScope.applicationId"/>
   <input name="mode" type="java.lang.String" required="true"/>
   <action-state id="setup">
      <on-entry>
         <evaluate expression="clubapplication_action.setupForm"/>
      </on-entry>
      <evaluate expression="clubapplication_action.setupReferenceData"/>
      <transition on="success" to="details"/>
   </action-state>
   <view-state id="details" view="/club/clubapplication_details">
      <secured attributes="ROLE_ADMIN, hasPermission('approve')"/>
      <transition on="approve" to="checkResources">
         <evaluate expression="clubapplication_action.bindAndValidate"/>
      </transition>
      <transition on="reject" to="reject"/>
      <transition on="close" to="cancel"/>
   </view-state>
   <decision-state id="checkResources">
      <if test="clubapplication_action.hasMissingResources" then="addMissingResources" else="approve"/>
   </decision-state>
   <subflow-state id="addMissingResources" subflow="league.wf.add.missing.resources">
      <transition on="finish" to="approve"/>
   </subflow-state>
   <action-state id="approve">
      <evaluate expression="clubapplication_action.approveApplication"/>
      <transition on="success" to="finish"/>
   </action-state>
   <action-state id="reject">
      <evaluate expression="clubapplication_action.rejectApplication"/>
      <transition on="success" to="finish"/>
   </action-state>
   <end-state id="cancel" view="/default_endpoint"/>
   <end-state id="finish" view="/default_endpoint"/>
</flow>`;

const BEANS = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
    <bean id="clubapplication_action" class="com.example.league.admin.web.club.ClubApplicationAction" autowire="byName"/>
    <bean id="someManage" class="com.example.league.admin.web.club.ClubApplicationManage"/>
</beans>`;

const FLOW_PATH = "admin/src/main/webapp/WEB-INF/flows/club/league.wf.clubapplication.details.xml";

describe("springxml preprocess sniff", () => {
  it("keeps flows and bean definitions, skips other XML", () => {
    expect(springxmlMeta.preprocess!(FLOW, FLOW_PATH)).toBeNull();
    expect(springxmlMeta.preprocess!(BEANS, "ctx.xml")).toBeNull();
    const pom = `<project xmlns="http://maven.apache.org/POM/4.0.0"><artifactId>x</artifactId></project>`;
    expect(springxmlMeta.preprocess!(pom, "pom.xml")).toEqual({ skip: expect.any(String) });
    const liquibase = `<databaseChangeLog><changeSet id="1"><createTable tableName="t"/></changeSet></databaseChangeLog>`;
    expect(springxmlMeta.preprocess!(liquibase, "changelog-1.xml")).toEqual({ skip: expect.any(String) });
  });
});

describe("parseFlow", () => {
  const flow = parseFlow(FLOW)!;

  it("captures states with kinds and spans", () => {
    expect(flow.states.map((s) => s.id)).toEqual([
      "setup", "details", "checkResources", "addMissingResources", "approve", "reject", "cancel", "finish",
    ]);
    expect(flow.states.find((s) => s.id === "details")!.kind).toBe("view-state");
    expect(flow.states.find((s) => s.id === "details")!.view).toBe("/club/clubapplication_details");
  });

  it("captures evaluates as bean.method calls and transitions as on:* calls", () => {
    const setup = flow.states.find((s) => s.id === "setup")!;
    expect(setup.calls.map((c) => c.name)).toEqual([
      "clubapplication_action.setupForm",
      "clubapplication_action.setupReferenceData",
      "on:success",
    ]);
    const details = flow.states.find((s) => s.id === "details")!;
    const approve = details.calls.find((c) => c.name === "on:approve")!;
    expect(approve.target).toBe("checkResources");
  });

  it("captures decision ifs and subflows; scope roots are never beans", () => {
    const dec = flow.states.find((s) => s.id === "checkResources")!;
    expect(dec.calls.map((c) => c.name)).toContain("clubapplication_action.hasMissingResources");
    expect(dec.calls.find((c) => c.name === "on:then")!.target).toBe("addMissingResources");
    const sub = flow.states.find((s) => s.id === "addMissingResources")!;
    expect(sub.calls.map((c) => c.name)).toContain("subflow:league.wf.add.missing.resources");
    // `flowScope.applicationId` (the <input>) must not read as a bean call.
    expect(flow.flowCalls.every((c) => !c.name.startsWith("flowScope"))).toBe(true);
  });
});

describe("springxmlSpec hooks", () => {
  it("emits view-states as frontend routes anchored on the flow id", () => {
    const routes = springxmlSpec.extractRoutes!(FLOW.split("\n"), [], FLOW_PATH);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.path).toBe("league.wf.clubapplication.details");
    expect(routes[0]!.kind).toBe("frontend");
    expect(routes[0]!.componentPath).toBe("/club/clubapplication_details");
    expect(routes[0]!.handler).toBe("clubapplication_details");
  });

  it("reads flow-level <secured> as inherited guards, state-level as own, and flow <input>s as params", () => {
    const routes = springxmlSpec.extractRoutes!(FLOW.split("\n"), [], FLOW_PATH);
    expect(routes[0]!.middleware).toEqual([
      'secured(attributes="ROLE_CLUBS, ROLE_ADMIN", match="any")',
      'secured(attributes="ROLE_ADMIN, hasPermission(\'approve\')")',
    ]);
    expect(routes[0]!.auth).toEqual({
      policies: ["hasPermission('approve')"],
      roles: ["ROLE_CLUBS", "ROLE_ADMIN"],
      schemes: [],
      anonymous: false,
      inherited: false,
    });
    expect(routes[0]!.params).toEqual([
      { name: "applicationId", type: null, binding: "query", inferred: true },
      { name: "mode", type: "java.lang.String", binding: "query", inferred: true },
    ]);
  });

  it("inherits only the flow-level guard on a state without its own <secured>", () => {
    const flow = `<flow xmlns="http://www.springframework.org/schema/webflow">
  <secured attributes="ROLE_X"/>
  <view-state id="a" view="/a"/>
  <subflow-state id="s" subflow="other"><input name="notFlowLevel" value="1"/></subflow-state>
  <view-state id="b" view="/b"/>
</flow>`;
    const routes = springxmlSpec.extractRoutes!(flow.split("\n"), [], "x/league.wf.a.xml");
    expect(routes.map((r) => r.path)).toEqual(["league.wf.a", "league.wf.a#b"]);
    for (const r of routes) {
      expect(r.auth).toEqual({ policies: [], roles: ["ROLE_X"], schemes: [], anonymous: false, inherited: true });
      expect(r.params).toBeUndefined();
    }
  });

  it("leaves auth and params absent on a flow that declares neither", () => {
    const flow = `<flow xmlns="http://www.springframework.org/schema/webflow"><view-state id="a" view="/a"/></flow>`;
    const [r] = springxmlSpec.extractRoutes!(flow.split("\n"), [], "x/league.wf.plain.xml");
    expect(r!.auth).toBeUndefined();
    expect(r!.params).toBeUndefined();
    expect(r!.middleware).toEqual([]);
  });

  it("emits states as functions tagged with their kind", () => {
    const fns = springxmlSpec.postProcessFunctions!(FLOW.split("\n"), []);
    expect(fns[0]!.name).toBe("<flow>");
    const details = fns.find((f) => f.name === "details")!;
    expect(details.decorators).toEqual(["view-state"]);
  });

  it("extracts bean id → class constants", () => {
    const consts = springxmlSpec.extractStringConstants!(BEANS.split("\n"));
    expect(consts["clubapplication_action"]).toBe("com.example.league.admin.web.club.ClubApplicationAction");
  });

  it("returns nothing for bean-definition files' flow hooks", () => {
    expect(springxmlSpec.postProcessFunctions!(BEANS.split("\n"), [])).toEqual([]);
    expect(springxmlSpec.extractRoutes!(BEANS.split("\n"), [], "ctx.xml")).toEqual([]);
  });

  it("derives the flow id from the file basename", () => {
    expect(flowIdOf(FLOW_PATH)).toBe("league.wf.clubapplication.details");
  });
});

// ─── Dispatch resolver ──────────────────────────────────────────────────────

function analysisOf(filePath: string, language: FileAnalysis["language"]): FileAnalysis {
  return createEmptyAnalysis(filePath, language);
}

describe("WebflowUiBridgeResolver", () => {
  const flowAnalysis = analysisOf(FLOW_PATH, "springxml");
  flowAnalysis.functions = springxmlSpec.postProcessFunctions!(FLOW.split("\n"), []);
  flowAnalysis.routes = springxmlSpec.extractRoutes!(FLOW.split("\n"), [], FLOW_PATH);

  const beansAnalysis = analysisOf("admin/src/main/webapp/WEB-INF/flows/club/actions-webflow.xml", "springxml");
  beansAnalysis.stringConstants = springxmlSpec.extractStringConstants!(BEANS.split("\n"));

  const jsp = analysisOf("admin/src/main/webapp/WEB-INF/views/club/clubapplication_details.jsp", "jsp");
  jsp.interactiveElements = [
    { element: "button", event: "click", handler: "approve", line: 10 },
    { element: "button", event: "click", handler: "reject", line: 11 },
    { element: "button", event: "click", handler: "nonexistent", line: 12 },
  ];

  const java = analysisOf("admin/src/main/java/com/example/league/admin/web/club/ClubApplicationAction.java", "java");
  java.classes = [{
    name: "ClubApplicationAction",
    extends: "FormAction",
    implements: [],
    decorators: [],
    methods: [
      { name: "approveApplication", params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 40, endLine: 60 },
      { name: "rejectApplication", params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 62, endLine: 70 },
      { name: "setupForm", params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 20, endLine: 30 },
    ],
    properties: [],
    isExported: true,
    line: 15,
    endLine: 90,
  }];

  const links = new WebflowUiBridgeResolver().resolve([flowAnalysis, beansAnalysis, jsp, java]);

  it("links flow evaluates to the Java bean methods", () => {
    const l = links.find((x) => x.sourceSymbol === "approve" && x.callName === "clubapplication_action.approveApplication")!;
    expect(l).toBeDefined();
    expect(l.targetFile).toBe(java.filePath);
    expect(l.targetSymbol).toBe("ClubApplicationAction.approveApplication");
  });

  it("falls back to the class anchor for inherited framework methods", () => {
    const l = links.find((x) => x.callName === "clubapplication_action.bindAndValidate")!;
    expect(l).toBeDefined();
    expect(l.targetSymbol).toBe("ClubApplicationAction");
  });

  it("anchors the flow route at its JSP view", () => {
    const l = links.find((x) => x.sourceSymbol === "route:USE league.wf.clubapplication.details")!;
    expect(l).toBeDefined();
    expect(l.targetFile).toBe(jsp.filePath);
    expect(l.targetSymbol).toBe("<component>");
  });

  it("wires JSP click events through transitions into action-state evaluates", () => {
    // approve → checkResources (decision) → approve action-state → approveApplication.
    const approve = links.find((x) => x.sourceFile === jsp.filePath && x.callName === "approve"
      && x.targetSymbol === "ClubApplicationAction.approveApplication");
    expect(approve).toBeDefined();
    // reject goes straight to the reject action-state.
    const reject = links.find((x) => x.sourceFile === jsp.filePath && x.callName === "reject"
      && x.targetSymbol === "ClubApplicationAction.rejectApplication");
    expect(reject).toBeDefined();
    // events with no matching transition produce nothing.
    expect(links.some((x) => x.callName === "nonexistent")).toBe(false);
  });

  it("links subflow states to the target flow's root", () => {
    const subFlow = analysisOf("admin/src/main/webapp/WEB-INF/flows/club/league.wf.add.missing.resources.xml", "springxml");
    subFlow.functions = springxmlSpec.postProcessFunctions!(
      `<flow xmlns="http://www.springframework.org/schema/webflow"><view-state id="pick" view="/club/pick"/></flow>`.split("\n"), []);
    const withSub = new WebflowUiBridgeResolver().resolve([flowAnalysis, beansAnalysis, jsp, java, subFlow]);
    const l = withSub.find((x) => x.callName === "subflow:league.wf.add.missing.resources")!;
    expect(l).toBeDefined();
    expect(l.targetFile).toBe(subFlow.filePath);
    expect(l.targetSymbol).toBe("<flow>");
  });
});
