import { describe, expect, it } from "vitest";
import "../../registry.js";
import { extractGoPathArgCalls, goFunctions, goRequestFactoryRows } from "./path-arg-calls.js";
import { extractGoDataSources } from "./data-sources.js";
import { extractGoImports } from "./imports.js";
import { expandRequestFactories } from "../../../core/api-targets.js";
import { buildImportIndex } from "../../../core/import-index.js";
import { createEmptyAnalysis, type DataSourceInfo, type FileAnalysis, type FunctionInfo } from "../../../types/analysis.js";

const HTTPLIB = `package httplib

import "net/http"

func NewClientRequest(method, url string) *ClientRequest {
\treturn &ClientRequest{
\t\turl: url,
\t\treq: &http.Request{Method: method, Header: make(http.Header)},
\t}
}

func newTestRequest(t testing.TB, method, url string) *http.Request {
\treq, _ := http.NewRequest(method, url, nil)
\treturn req
}
`;

const INTERNAL = `package private

import (
\t"context"

\t"example.com/league/modules/httplib"
)

func NewInternalRequest(ctx context.Context, url, method string) *httplib.ClientRequest {
\treturn httplib.NewClientRequest(method, url).
\t\tSetContext(ctx)
}

func newInternalRequestAPI(ctx context.Context, url, method string, body ...any) *httplib.ClientRequest {
\treq := NewInternalRequest(ctx, url, method)
\treturn req
}
`;

const MANAGER = `package private

import (
\t"context"
\t"fmt"

\t"example.com/league/modules/setting"
)

func Shutdown(ctx context.Context) {
\treqURL := setting.LocalURL + "api/internal/manager/shutdown"
\treq := newInternalRequestAPI(ctx, reqURL, "POST")
\treq.Header("Content-Type", "application/json")
}

func Transfer(ctx context.Context, clubID int64) {
\treqURL := setting.LocalURL + fmt.Sprintf("api/internal/club/%d/transfer", clubID)
\tnewInternalRequestAPI(ctx, reqURL, http.MethodPut)
}

func Lookup(ctx context.Context, href string) {
\tnewInternalRequestAPI(ctx, href, "GET")
}
`;

const HOOKS = `package private

import (
\t"context"
\t"fmt"

\t"example.com/league/modules/setting"
)

func newHookRequest(ctx context.Context, hookName, clubName string) {
\treqURL := setting.LocalURL + fmt.Sprintf("api/internal/hook/%s/%s", hookName, url.PathEscape(clubName))
\tnewInternalRequestAPI(ctx, reqURL, "POST")
}

func HookKickOff(ctx context.Context, clubName string) {
\tnewHookRequest(ctx, "kick-off", clubName)
}

func HookFullTime(ctx context.Context, clubName string) {
\tnewHookRequest(ctx, "full-time", clubName)
}
`;

function goFile(filePath: string, src: string): FileAnalysis {
  const lines = src.split("\n");
  const functions = goFunctions(lines).map((f) => ({ name: `fn${f.start}`, line: f.start + 1, endLine: f.end + 1, params: f.params.map((name) => ({ name })) }) as unknown as FunctionInfo);
  return {
    ...createEmptyAnalysis(filePath, "go"),
    imports: extractGoImports(lines),
    functions,
    dataSources: extractGoDataSources(lines),
    pathArgCalls: extractGoPathArgCalls(lines),
  };
}

describe("Go request factories", () => {
  it("reads a request built from its function's method and URL parameters, never a test helper's", () => {
    expect(goRequestFactoryRows(HTTPLIB.split("\n")).map((d) => `${d.name} ${d.target} ${d.line}`)).toEqual(["http.Request ${url} 8"]);
  });

  it("records the calls naming an endpoint: literals, locals built from them, and the caller's own URL parameter", () => {
    const sites = extractGoPathArgCalls(MANAGER.split("\n"));
    expect(sites).toEqual([
      { callee: "newInternalRequestAPI", args: [null, "${setting.LocalURL}api/internal/manager/shutdown", "POST"], argNames: ["ctx", null, null], method: "POST", line: 12 },
      { callee: "newInternalRequestAPI", args: [null, "${setting.LocalURL}api/internal/club/${clubID}/transfer", "PUT"], argNames: ["ctx", null, null], method: "PUT", line: 18 },
    ]);
    expect(extractGoPathArgCalls(INTERNAL.split("\n")).map((s) => `${s.receiver ?? ""}.${s.callee} ${JSON.stringify(s.argNames)}`)).toEqual([
      'httplib.NewClientRequest ["method","url"]',
      '.NewInternalRequest ["ctx","url","method"]',
    ]);
  });

  it("follows a factory calling a factory, level by level, to the call that names the endpoint", () => {
    const analyses = [goFile("modules/httplib/request.go", HTTPLIB), goFile("modules/private/internal.go", INTERNAL), goFile("modules/private/manager.go", MANAGER)];
    // The factories' functions carry their real names.
    analyses[0]!.functions[0]!.name = "NewClientRequest";
    analyses[1]!.functions[0]!.name = "NewInternalRequest";
    analyses[1]!.functions[1]!.name = "newInternalRequestAPI";
    const calls = analyses.flatMap((a) => a.dataSources.filter((d) => d.kind === "api-call").map((d) => ({ ...d, filePath: a.filePath }))) as Array<DataSourceInfo & { filePath: string }>;
    expect(calls.map((c) => c.target)).toEqual(["${url}"]);
    expect(expandRequestFactories(calls, analyses, buildImportIndex(analyses))).toBe(2);
    expect(calls.slice(1).map((c) => `${c.filePath}:${c.line} ${c.name} ${c.target} via ${c.via}`)).toEqual([
      "modules/private/manager.go:12 POST ${setting.LocalURL}api/internal/manager/shutdown via newInternalRequestAPI",
      "modules/private/manager.go:18 PUT ${setting.LocalURL}api/internal/club/${clubID}/transfer via newInternalRequestAPI",
    ]);
  });

  it("fills a factory's URL parameter from the literal its callers hand it, though that is no path (real-repo FP)", () => {
    const analyses = [goFile("modules/httplib/request.go", HTTPLIB), goFile("modules/private/internal.go", INTERNAL), goFile("modules/private/hook.go", HOOKS)];
    analyses[0]!.functions[0]!.name = "NewClientRequest";
    analyses[1]!.functions[0]!.name = "NewInternalRequest";
    analyses[1]!.functions[1]!.name = "newInternalRequestAPI";
    analyses[2]!.functions[0]!.name = "newHookRequest";
    expect(analyses[2]!.pathArgCalls!.filter((p) => p.callee === "newHookRequest").map((p) => `${p.line} ${JSON.stringify(p.args)}`)).toEqual([
      '16 [null,"kick-off",null]',
      '20 [null,"full-time",null]',
    ]);
    const calls = analyses.flatMap((a) => a.dataSources.filter((d) => d.kind === "api-call").map((d) => ({ ...d, filePath: a.filePath }))) as Array<DataSourceInfo & { filePath: string }>;
    expandRequestFactories(calls, analyses, buildImportIndex(analyses));
    expect(calls.slice(1).map((c) => `${c.line} ${c.target}`)).toEqual([
      "12 ${setting.LocalURL}api/internal/hook/${hookName}/{}",
      "16 ${setting.LocalURL}api/internal/hook/kick-off/{}",
      "20 ${setting.LocalURL}api/internal/hook/full-time/{}",
    ]);
  });
});

describe("Go in-process broker", () => {
  it("publishes and subscribes on the topic the same function builds, and on a Sprintf format", () => {
    const src = `package events

import "example.com/league/services/pubsub"

func publishMatchEvent(clubID int64, b []byte) {
\tpubsub.DefaultBroker.Publish(pubsub.ClubTopic(clubID), b)
\tpubsub.DefaultBroker.Publish(fmt.Sprintf("club-%d", clubID), b)
}

func Serve(clubID int64) {
\tch, cancel := pubsub.DefaultBroker.Subscribe(pubsub.ClubTopic(clubID))
\tdefer cancel()
}
`;
    expect(extractGoDataSources(src.split("\n")).filter((d) => d.kind.startsWith("queue")).map((d) => `${d.kind} ${d.target}`)).toEqual([
      "queue-publish pubsub.ClubTopic()",
      "queue-publish club-{}",
      "queue-consume pubsub.ClubTopic()",
    ]);
  });
});

describe("Go domain events dispatched from a variable", () => {
  it("types the event by the parameter or local holding it, never by the bus's own interface", () => {
    const src = `package models

func revokeSeason(s *xorm.Session, event *SeasonRevokedEvent) error {
\tevents.DispatchOnCommit(s, event)
\treturn nil
}

func transfer(s *xorm.Session) {
\tev := &PlayerTransferredEvent{PlayerID: 7}
\tevents.Dispatch(ev)
}

func forward(e events.Event) {
\tevents.Dispatch(e)
}
`;
    expect(extractGoDataSources(src.split("\n")).filter((d) => d.kind === "queue-publish").map((d) => `${d.line} ${d.target}`)).toEqual([
      "4 SeasonRevokedEvent",
      "10 PlayerTransferredEvent",
    ]);
  });
});
