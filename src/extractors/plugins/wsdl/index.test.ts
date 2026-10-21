import { describe, it, expect, vi } from "vitest";
import { extractWsdlRoutes, extractWsdlEntities, extractWsdlRelations } from "./index.js";
import { wsdlMeta } from "./meta.js";
import { attachRequestSchemas } from "../../../core/request-schemas.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";

// The core pass asks the registry for the plugin's hooks; answer with this
// plugin's meta directly so the test loads nothing outside the folder.
vi.mock("../../registry.js", () => ({ pluginFor: () => wsdlMeta }));

const WSDL = `<?xml version="1.0"?>
<definitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:players">
  <types>
    <xsd:schema>
      <xsd:complexType name="Player">
        <xsd:sequence>
          <xsd:element name="id" type="xsd:int"/>
          <xsd:element name="name" type="xsd:string"/>
          <xsd:element name="cars" type="tns:Car" maxOccurs="unbounded"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:complexType name="Car">
        <xsd:sequence>
          <xsd:element name="id" type="xsd:int"/>
        </xsd:sequence>
      </xsd:complexType>
    </xsd:schema>
  </types>
  <portType name="PlayerService">
    <operation name="GetPlayer">
      <input message="tns:GetPlayerRequest"/>
      <output message="tns:GetPlayerResponse"/>
    </operation>
    <operation name="ListPlayers"/>
  </portType>
  <binding name="PlayerServiceSoap" type="tns:PlayerService">
    <operation name="GetPlayer"/>
  </binding>
</definitions>
`;

describe("WSDL route extraction", () => {
  it("extracts one api route per portType operation (not binding duplicates)", () => {
    const routes = extractWsdlRoutes(WSDL.split("\n"));
    expect(routes.map((r) => `${r.path} -> ${r.handler}`)).toEqual([
      "/GetPlayer -> GetPlayer",
      "/ListPlayers -> ListPlayers",
    ]);
    expect(routes.every((r) => r.kind === "api")).toBe(true);
  });

  it("leaves auth absent when the document carries no policy markup", () => {
    expect(extractWsdlRoutes(WSDL.split("\n")).every((r) => r.auth === undefined && r.middleware.length === 0)).toBe(true);
  });
});

describe("WSDL / XSD entities", () => {
  it("turns complexTypes into entities with element properties", () => {
    const entities = extractWsdlEntities(WSDL.split("\n"));
    expect(entities.map((e) => e.name).sort()).toEqual(["Car", "Player"]);
    const player = entities.find((e) => e.name === "Player")!;
    expect(player.decorators).toEqual(["entity", "wsdl"]);
    expect(player.properties.map((p) => p.name)).toEqual(["id", "name", "cars"]);
  });

  it("derives relations from tns: element types (maxOccurs unbounded => one-to-many)", () => {
    const lines = WSDL.split("\n");
    const rels = extractWsdlRelations(lines, extractWsdlEntities(lines));
    expect(rels).toEqual([
      expect.objectContaining({ fromEntity: "Player", fromField: "cars", toEntity: "Car", cardinality: "one-to-many" }),
    ]);
  });
});

// ─── Route attribute layer (params / auth) + request schema ───────────────────

const META_WSDL = `<?xml version="1.0"?>
<definitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:players"
             xmlns:wsp="http://www.w3.org/ns/ws-policy" xmlns:sp="http://docs.oasis-open.org/ws-sx/ws-securitypolicy/200702">
  <wsp:Policy wsu:Id="UT"><sp:SupportingTokens><wsp:Policy><sp:UsernameToken/></wsp:Policy></sp:SupportingTokens></wsp:Policy>
  <types>
    <xsd:schema>
      <xsd:complexType name="Address">
        <xsd:sequence>
          <xsd:element name="street" type="xsd:string"/>
          <xsd:element name="city" type="xsd:string" minOccurs="0"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:element name="CreatePlayerRequest">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="name" type="xsd:string"/>
            <xsd:element name="email" type="xsd:string" minOccurs="0"/>
            <xsd:element name="birthDate" type="xsd:date" nillable="true"/>
            <xsd:element name="address" type="tns:Address" minOccurs="0"/>
            <xsd:element name="tags" type="xsd:string" minOccurs="0" maxOccurs="unbounded"/>
            <xsd:element name="extra">
              <xsd:complexType><xsd:sequence><xsd:element name="inner" type="xsd:int"/></xsd:sequence></xsd:complexType>
            </xsd:element>
            <xsd:element name="after" type="xsd:long"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </types>
  <message name="GetPlayerRequest">
    <part name="id" type="xsd:int"/>
    <part name="verbose" type="xsd:boolean"/>
  </message>
  <message name="CreatePlayerRequest">
    <part name="parameters" element="tns:CreatePlayerRequest"/>
  </message>
  <portType name="PlayerService">
    <operation name="GetPlayer">
      <input message="tns:GetPlayerRequest"/>
    </operation>
    <operation name="CreatePlayer">
      <input message="tns:CreatePlayerRequest"/>
    </operation>
    <operation name="Ping"/>
  </portType>
</definitions>
`;

describe("WSDL route attribute layer", () => {
  const routes = extractWsdlRoutes(META_WSDL.split("\n"));
  const byName = (n: string) => routes.find((r) => r.handler === n)!;

  it("turns the input message's parts into body-bound params (rpc and document style)", () => {
    expect(byName("GetPlayer").params).toEqual([
      { name: "id", type: "int", binding: "body" },
      { name: "verbose", type: "boolean", binding: "body" },
    ]);
    expect(byName("CreatePlayer").params).toEqual([{ name: "parameters", type: "CreatePlayerRequest", binding: "body" }]);
    expect(byName("Ping").params).toBeUndefined();
  });

  it("puts a ws-security scheme on every operation when the document carries WS-Policy markup", () => {
    for (const r of routes) {
      expect(r.auth).toEqual({ policies: [], roles: [], schemes: ["ws-security"], anonymous: false, inherited: true });
      expect(r.middleware).toEqual(["wsp:Policy"]);
    }
  });

  it("never marks a contract-declared binding as inferred", () => {
    expect(routes.flatMap((r) => r.params ?? []).some((p) => p.inferred)).toBe(false);
  });
});

describe("WSDL / XSD properties for the request-schema pass", () => {
  const entities = extractWsdlEntities(META_WSDL.split("\n"));
  const req = entities.find((e) => e.name === "CreatePlayerRequest")!;
  const prop = (n: string) => req.properties.find((p) => p.name === n)!;

  it("emits a document-style wrapper element as an entity and skips nested anonymous types", () => {
    expect(entities.map((e) => e.name)).toEqual(["Address", "CreatePlayerRequest"]);
    expect(req.properties.map((p) => p.name)).toEqual(["name", "email", "birthDate", "address", "tags", "extra", "after"]);
  });

  it("reads minOccurs/nillable as optional, everything else required; unbounded as an array", () => {
    expect(prop("name")).toMatchObject({ type: "string", isRequired: true });
    expect(prop("email").isRequired).toBeUndefined();
    expect(prop("birthDate")).toMatchObject({ type: "date?" });
    expect(prop("birthDate").isRequired).toBeUndefined();
    expect(prop("tags").type).toBe("string[]");
    expect(prop("after")).toMatchObject({ type: "long", isRequired: true });
  });

  it("maps XSD scalars through the hooks", async () => {
    const { wsdlRequestSchema: h } = await import("./request-schema.js");
    expect(h.describeType("string")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("int")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int32" } });
    expect(h.describeType("long")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("decimal")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(h.describeType("boolean")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(h.describeType("dateTime")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("base64Binary")).toEqual({ kind: "scalar", schema: { type: "string", format: "byte" } });
    expect(h.describeType("Car[]")).toEqual({ kind: "array", element: "Car" });
    expect(h.describeType("anyType")).toEqual({ kind: "any" });
    expect(h.describeType("Car")).toEqual({ kind: "object", name: "Car" });
    expect(h.unwrapNullable("date?")).toEqual({ type: "date", nullable: true });
  });

  it("flattens a document-style body through the core pass", () => {
    const lines = META_WSDL.split("\n");
    const analysis = createEmptyAnalysis("players.wsdl", "wsdl");
    analysis.projectId = "root";
    analysis.classes = extractWsdlEntities(lines);
    const routes = extractWsdlRoutes(lines).map((r) => ({ ...r, filePath: "players.wsdl", projectId: "root" }));
    // GetPlayer's rpc-style `id: int` part gets a scalar schema too — the core
    // pass skips only a bare unresolved `$ref`.
    expect(attachRequestSchemas(routes, [analysis])).toBe(2);
    const create = routes.find((r) => r.handler === "CreatePlayer") as typeof routes[number] & { requestSchema?: unknown };
    expect(create.requestSchema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        birthDate: { type: "string", format: "date", nullable: true },
        address: { type: "object", properties: { street: { type: "string" }, city: { type: "string" } }, required: ["street"] },
        tags: { type: "array", items: { type: "string" } },
        extra: {},
        after: { type: "integer", format: "int64" },
      },
      required: ["name", "extra", "after"],
    });
  });
});
