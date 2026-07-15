import { describe, it, expect } from "vitest";
import { extractWsdlRoutes, extractWsdlEntities, extractWsdlRelations } from "./index.js";

const WSDL = `<?xml version="1.0"?>
<definitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:users">
  <types>
    <xsd:schema>
      <xsd:complexType name="User">
        <xsd:sequence>
          <xsd:element name="id" type="xsd:int"/>
          <xsd:element name="name" type="xsd:string"/>
          <xsd:element name="orders" type="tns:Order" maxOccurs="unbounded"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:complexType name="Order">
        <xsd:sequence>
          <xsd:element name="id" type="xsd:int"/>
        </xsd:sequence>
      </xsd:complexType>
    </xsd:schema>
  </types>
  <portType name="UserService">
    <operation name="GetUser">
      <input message="tns:GetUserRequest"/>
      <output message="tns:GetUserResponse"/>
    </operation>
    <operation name="ListUsers"/>
  </portType>
  <binding name="UserServiceSoap" type="tns:UserService">
    <operation name="GetUser"/>
  </binding>
</definitions>
`;

describe("WSDL route extraction", () => {
  it("extracts one api route per portType operation (not binding duplicates)", () => {
    const routes = extractWsdlRoutes(WSDL.split("\n"));
    expect(routes.map((r) => `${r.path} -> ${r.handler}`)).toEqual([
      "/GetUser -> GetUser",
      "/ListUsers -> ListUsers",
    ]);
    expect(routes.every((r) => r.kind === "api")).toBe(true);
  });
});

describe("WSDL / XSD entities", () => {
  it("turns complexTypes into entities with element properties", () => {
    const entities = extractWsdlEntities(WSDL.split("\n"));
    expect(entities.map((e) => e.name).sort()).toEqual(["Order", "User"]);
    const user = entities.find((e) => e.name === "User")!;
    expect(user.decorators).toEqual(["entity", "wsdl"]);
    expect(user.properties.map((p) => p.name)).toEqual(["id", "name", "orders"]);
  });

  it("derives relations from tns: element types (maxOccurs unbounded => one-to-many)", () => {
    const lines = WSDL.split("\n");
    const rels = extractWsdlRelations(lines, extractWsdlEntities(lines));
    expect(rels).toEqual([
      expect.objectContaining({ fromEntity: "User", fromField: "orders", toEntity: "Order", cardinality: "one-to-many" }),
    ]);
  });
});
