import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractPascalRoutes } from "./routes.js";
import type { RouteInfo } from "../../../types/analysis.js";

/**
 * RAD Server (EMS) resources declare their routing as RTTI attributes in the
 * INTERFACE section — `[ResourceName]` on the class, `[ResourceSuffix]` /
 * `[EndpointMethod]` on the method — while the body that reads the request
 * lives on the IMPLEMENTATION `defProc`. The extractor joins the two.
 */
const UNIT = `unit ApiController;
interface
uses EMS.Services, EMS.ResourceAPI, EMS.ResourceTypes;
type
  [ResourceName('users')]
  TUserController = class(TDataModule)
  public
    function acceptGetLegacy: TJSONArray;

    [ResourceSuffix('/')]
    procedure GetUsers(const AContext: TEndpointContext;
      const ARequest: TEndpointRequest; const AResponse: TEndpointResponse);

    [ResourceSuffix('/{id}')]
    procedure GetUserByID(const AContext: TEndpointContext;
      const ARequest: TEndpointRequest; const AResponse: TEndpointResponse);

    [ResourceSuffix('/')]
    procedure PostUser(const AContext: TEndpointContext;
      const ARequest: TEndpointRequest; const AResponse: TEndpointResponse);

    [ResourceSuffix('/{id}/avatar')]
    [EndpointMethod(TEndpointRequest.TMethod.Put)]
    procedure UploadAvatar(const AContext: TEndpointContext;
      const ARequest: TEndpointRequest; const AResponse: TEndpointResponse);

    procedure Helper;
  end;
implementation

function TUserController.acceptGetLegacy: TJSONArray;
begin
  Result := nil;
end;

procedure TUserController.GetUsers(const AContext: TEndpointContext;
  const ARequest: TEndpointRequest; const AResponse: TEndpointResponse);
var
  Filter: string;
begin
  Filter := ARequest.Params.Values['q'];
  AResponse.Body.SetValue(TJSONArray.Create, True);
end;

procedure TUserController.GetUserByID(const AContext: TEndpointContext;
  const ARequest: TEndpointRequest; const AResponse: TEndpointResponse);
var
  ID: Integer;
begin
  ID := ARequest.Params.Values['id'].ToInteger;
end;

procedure TUserController.PostUser(const AContext: TEndpointContext;
  const ARequest: TEndpointRequest; const AResponse: TEndpointResponse);
var
  Data: TJSONObject;
begin
  Data := ARequest.Body.GetObject;
end;

procedure TUserController.UploadAvatar(const AContext: TEndpointContext;
  const ARequest: TEndpointRequest; const AResponse: TEndpointResponse);
begin
  FService.SaveAvatar(ARequest.Params.Values['id'], ARequest.Body.GetStream);
end;

procedure TUserController.Helper;
begin
end;
end.`;

async function routesOf(code: string): Promise<RouteInfo[]> {
  const tree = await parseSource(code, "pascal" as any, "ApiController.pas");
  const routes: RouteInfo[] = [];
  extractPascalRoutes(tree.rootNode, routes, code);
  return routes;
}

describe("pascal routes — RAD Server attributes", () => {
  it("builds the path from [ResourceName] + [ResourceSuffix] and the verb from the name prefix or [EndpointMethod]", async () => {
    const routes = await routesOf(UNIT);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /GetLegacy -> TUserController.acceptGetLegacy",
      "GET /users -> TUserController.GetUsers",
      "GET /users/{id} -> TUserController.GetUserByID",
      "POST /users -> TUserController.PostUser",
      "PUT /users/{id}/avatar -> TUserController.UploadAvatar",
    ]);
    // `Helper` carries no attribute and no verb prefix: not an endpoint.
    expect(routes.some((r) => r.handler?.endsWith("Helper"))).toBe(false);
  });

  it("marks the injected context/request/response as services and reads the body's request access", async () => {
    const routes = await routesOf(UNIT);
    const byName = (n: string) => routes.find((r) => r.handler === `TUserController.${n}`)!;
    expect(byName("GetUsers").params).toEqual([
      { name: "AContext", type: "TEndpointContext", binding: "services", inferred: true },
      { name: "ARequest", type: "TEndpointRequest", binding: "services", inferred: true },
      { name: "AResponse", type: "TEndpointResponse", binding: "services", inferred: true },
      { name: "q", type: null, binding: "query", inferred: true },
    ]);
    expect(byName("GetUserByID").params!.slice(3)).toEqual([
      { name: "id", type: null, binding: "route", inferred: true },
    ]);
    expect(byName("PostUser").params!.slice(3)).toEqual([
      { name: "body", type: "TJSONObject", binding: "body", inferred: true },
    ]);
    expect(byName("UploadAvatar").params!.slice(3)).toEqual([
      { name: "id", type: null, binding: "route", inferred: true },
      { name: "body", type: "TStream", binding: "body", inferred: true },
    ]);
  });

  it("keeps the DataSnap accept/update/cancel convention for classes without attributes", async () => {
    const code = `unit ServerMethods;
interface
uses Datasnap.DSServer;
type
  TServerMethods1 = class(TDSServerModule)
  public
    function UpdateAll(Value: string): string;
  end;
implementation
function TServerMethods1.UpdateAll(Value: string): string;
begin
  Result := Value;
end;
end.`;
    const routes = await routesOf(code);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ httpMethod: "PUT", path: "/All", handler: "TServerMethods1.UpdateAll" });
    expect(routes[0]!.params).toBeUndefined();
    expect(routes[0]!.auth).toBeUndefined();
  });
});
