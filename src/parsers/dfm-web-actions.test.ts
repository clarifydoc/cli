import { describe, it, expect } from "vitest";
import { parseDfm } from "./dfm-parser.js";

describe("WebBroker actions in a web module's form", () => {
  it("makes each action item with a path and a handler a route of the form's class", () => {
    const a = parseDfm(`object LeagueModule: TLeagueModule
  OldCreateOrder = False
  Actions = <
    item
      Default = True
      Name = 'DefaultHandler'
      PathInfo = '/'
      OnAction = LeagueModuleDefaultHandlerAction
    end
    item
      MethodType = mtGet
      Name = 'getFixtures'
      PathInfo = '/fixtures'
      OnAction = LeagueModuleGetFixturesAction
    end
    item
      MethodType = mtPost
      Name = 'addPlayer'
      PathInfo = 'players'
      OnAction = LeagueModuleAddPlayerAction
    end>
  Height = 230
  Width = 415
end
`, "Server/LeagueModuleUnit.dfm");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler} @${r.line}`)).toEqual([
      "null / TLeagueModule.LeagueModuleDefaultHandlerAction @4",
      "GET /fixtures TLeagueModule.LeagueModuleGetFixturesAction @10",
      "POST /players TLeagueModule.LeagueModuleAddPlayerAction @16",
    ]);
  });
});

describe("an Indy HTTP server on a form", () => {
  it("answers every path in its OnCommandGet handler", () => {
    const a = parseDfm(`object ScoreForm: TScoreForm
  Caption = 'Scores'
  object IdHTTPServer1: TIdHTTPServer
    Bindings = <>
    DefaultPort = 8081
    OnCommandGet = IdHTTPServer1CommandGet
  end
end
`, "Scores/fMain.fmx");
    expect(a.routes.map((r) => `${r.httpMethod ?? "*"} ${r.path} ${r.handler}`)).toEqual(["* /** TScoreForm.IdHTTPServer1CommandGet"]);
  });
});
