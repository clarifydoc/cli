import { describe, it, expect } from "vitest";
import { springxmlSpec, parseFlow, flowIdOf } from "./index.js";
import { springxmlMeta } from "./meta.js";
import { WebflowUiBridgeResolver } from "./dispatch.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";

// Trimmed from a real EOS flow: view-state with transitions, action-states
// with evaluates, a subflow, a decision-state and an end-state.
const FLOW = `<?xml version="1.0" encoding="UTF-8"?>
<flow xmlns="http://www.springframework.org/schema/webflow"
      xsi:schemaLocation="http://www.springframework.org/schema/webflow/spring-webflow-2.0.xsd"
      start-state="setup">
   <input name="applicationId" value="flowScope.applicationId"/>
   <action-state id="setup">
      <on-entry>
         <evaluate expression="accountapplication_action.setupForm"/>
      </on-entry>
      <evaluate expression="accountapplication_action.setupReferenceData"/>
      <transition on="success" to="details"/>
   </action-state>
   <view-state id="details" view="/account/accountapplication_details">
      <transition on="approve" to="checkResources">
         <evaluate expression="accountapplication_action.bindAndValidate"/>
      </transition>
      <transition on="reject" to="reject"/>
      <transition on="close" to="cancel"/>
   </view-state>
   <decision-state id="checkResources">
      <if test="accountapplication_action.hasMissingResources" then="addMissingResources" else="approve"/>
   </decision-state>
   <subflow-state id="addMissingResources" subflow="eos.wf.add.missing.resources">
      <transition on="finish" to="approve"/>
   </subflow-state>
   <action-state id="approve">
      <evaluate expression="accountapplication_action.approveApplication"/>
      <transition on="success" to="finish"/>
   </action-state>
   <action-state id="reject">
      <evaluate expression="accountapplication_action.rejectApplication"/>
      <transition on="success" to="finish"/>
   </action-state>
   <end-state id="cancel" view="/default_endpoint"/>
   <end-state id="finish" view="/default_endpoint"/>
</flow>`;

const BEANS = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
    <bean id="accountapplication_action" class="com.ist.eos.admin.web.account.AccountApplicationAction" autowire="byName"/>
    <bean id="someManage" class="com.ist.eos.admin.web.account.AccountApplicationManage"/>
</beans>`;

const FLOW_PATH = "admin/src/main/webapp/WEB-INF/flows/account/eos.wf.accountapplication.details.xml";

describe("springxml preprocess sniff", () => {
  it("keeps flows and bean definitions, skips other XML", () => {
    expect(springxmlMeta.preprocess!(FLOW, FLOW_PATH)).toBeNull();
    expect(springxmlMeta.preprocess!(BEANS, "ctx.xml")).toBeNull();
    const pom = `<project xmlns="http://maven.apache.org/POM/4.0.0"><artifactId>x</artifactId></project>`;
    expect(springxmlMeta.preprocess!(pom, "pom.xml")).toEqual({ skip: expect.any(String) });
    const liquibase = `<databaseChangeLog><changeSet id="1"><createTable tableName="t"/></changeSet></databaseChangeLog>`;
    expect(springxmlMeta.preprocess!(liquibase, "EOS-1.xml")).toEqual({ skip: expect.any(String) });
  });
});

describe("parseFlow", () => {
  const flow = parseFlow(FLOW)!;

  it("captures states with kinds and spans", () => {
    expect(flow.states.map((s) => s.id)).toEqual([
      "setup", "details", "checkResources", "addMissingResources", "approve", "reject", "cancel", "finish",
    ]);
    expect(flow.states.find((s) => s.id === "details")!.kind).toBe("view-state");
    expect(flow.states.find((s) => s.id === "details")!.view).toBe("/account/accountapplication_details");
  });

  it("captures evaluates as bean.method calls and transitions as on:* calls", () => {
    const setup = flow.states.find((s) => s.id === "setup")!;
    expect(setup.calls.map((c) => c.name)).toEqual([
      "accountapplication_action.setupForm",
      "accountapplication_action.setupReferenceData",
      "on:success",
    ]);
    const details = flow.states.find((s) => s.id === "details")!;
    const approve = details.calls.find((c) => c.name === "on:approve")!;
    expect(approve.target).toBe("checkResources");
  });

  it("captures decision ifs and subflows; scope roots are never beans", () => {
    const dec = flow.states.find((s) => s.id === "checkResources")!;
    expect(dec.calls.map((c) => c.name)).toContain("accountapplication_action.hasMissingResources");
    expect(dec.calls.find((c) => c.name === "on:then")!.target).toBe("addMissingResources");
    const sub = flow.states.find((s) => s.id === "addMissingResources")!;
    expect(sub.calls.map((c) => c.name)).toContain("subflow:eos.wf.add.missing.resources");
    // `flowScope.applicationId` (the <input>) must not read as a bean call.
    expect(flow.flowCalls.every((c) => !c.name.startsWith("flowScope"))).toBe(true);
  });
});

describe("springxmlSpec hooks", () => {
  it("emits view-states as frontend routes anchored on the flow id", () => {
    const routes = springxmlSpec.extractRoutes!(FLOW.split("\n"), [], FLOW_PATH);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.path).toBe("eos.wf.accountapplication.details");
    expect(routes[0]!.kind).toBe("frontend");
    expect(routes[0]!.componentPath).toBe("/account/accountapplication_details");
    expect(routes[0]!.handler).toBe("accountapplication_details");
  });

  it("emits states as functions tagged with their kind", () => {
    const fns = springxmlSpec.postProcessFunctions!(FLOW.split("\n"), []);
    expect(fns[0]!.name).toBe("<flow>");
    const details = fns.find((f) => f.name === "details")!;
    expect(details.decorators).toEqual(["view-state"]);
  });

  it("extracts bean id → class constants", () => {
    const consts = springxmlSpec.extractStringConstants!(BEANS.split("\n"));
    expect(consts["accountapplication_action"]).toBe("com.ist.eos.admin.web.account.AccountApplicationAction");
  });

  it("returns nothing for bean-definition files' flow hooks", () => {
    expect(springxmlSpec.postProcessFunctions!(BEANS.split("\n"), [])).toEqual([]);
    expect(springxmlSpec.extractRoutes!(BEANS.split("\n"), [], "ctx.xml")).toEqual([]);
  });

  it("derives the flow id from the file basename", () => {
    expect(flowIdOf(FLOW_PATH)).toBe("eos.wf.accountapplication.details");
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

  const beansAnalysis = analysisOf("admin/src/main/webapp/WEB-INF/flows/account/actions-webflow.xml", "springxml");
  beansAnalysis.stringConstants = springxmlSpec.extractStringConstants!(BEANS.split("\n"));

  const jsp = analysisOf("admin/src/main/webapp/WEB-INF/views/account/accountapplication_details.jsp", "jsp");
  jsp.interactiveElements = [
    { element: "button", event: "click", handler: "approve", line: 10 },
    { element: "button", event: "click", handler: "reject", line: 11 },
    { element: "button", event: "click", handler: "nonexistent", line: 12 },
  ];

  const java = analysisOf("admin/src/main/java/com/ist/eos/admin/web/account/AccountApplicationAction.java", "java");
  java.classes = [{
    name: "AccountApplicationAction",
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
    const l = links.find((x) => x.sourceSymbol === "approve" && x.callName === "accountapplication_action.approveApplication")!;
    expect(l).toBeDefined();
    expect(l.targetFile).toBe(java.filePath);
    expect(l.targetSymbol).toBe("AccountApplicationAction.approveApplication");
  });

  it("falls back to the class anchor for inherited framework methods", () => {
    const l = links.find((x) => x.callName === "accountapplication_action.bindAndValidate")!;
    expect(l).toBeDefined();
    expect(l.targetSymbol).toBe("AccountApplicationAction");
  });

  it("anchors the flow route at its JSP view", () => {
    const l = links.find((x) => x.sourceSymbol === "route:USE eos.wf.accountapplication.details")!;
    expect(l).toBeDefined();
    expect(l.targetFile).toBe(jsp.filePath);
    expect(l.targetSymbol).toBe("<component>");
  });

  it("wires JSP click events through transitions into action-state evaluates", () => {
    // approve → checkResources (decision) → approve action-state → approveApplication.
    const approve = links.find((x) => x.sourceFile === jsp.filePath && x.callName === "approve"
      && x.targetSymbol === "AccountApplicationAction.approveApplication");
    expect(approve).toBeDefined();
    // reject goes straight to the reject action-state.
    const reject = links.find((x) => x.sourceFile === jsp.filePath && x.callName === "reject"
      && x.targetSymbol === "AccountApplicationAction.rejectApplication");
    expect(reject).toBeDefined();
    // events with no matching transition produce nothing.
    expect(links.some((x) => x.callName === "nonexistent")).toBe(false);
  });

  it("links subflow states to the target flow's root", () => {
    const subFlow = analysisOf("admin/src/main/webapp/WEB-INF/flows/account/eos.wf.add.missing.resources.xml", "springxml");
    subFlow.functions = springxmlSpec.postProcessFunctions!(
      `<flow xmlns="http://www.springframework.org/schema/webflow"><view-state id="pick" view="/account/pick"/></flow>`.split("\n"), []);
    const withSub = new WebflowUiBridgeResolver().resolve([flowAnalysis, beansAnalysis, jsp, java, subFlow]);
    const l = withSub.find((x) => x.callName === "subflow:eos.wf.add.missing.resources")!;
    expect(l).toBeDefined();
    expect(l.targetFile).toBe(subFlow.filePath);
    expect(l.targetSymbol).toBe("<flow>");
  });
});
