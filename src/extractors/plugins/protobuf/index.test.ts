import { describe, expect, it } from "vitest";
import { extractProtoMessages, extractProtoRoutes } from "./index.js";
import { protobufRequestSchema } from "./request-schema.js";

const PROTO = `syntax = "proto3";
package shop.v1; // the package qualifies every service

/* A block comment with a fake: service Fake { rpc Nope (A) returns (B); } */
service Catalog {
  rpc ListItems (ListItemsRequest) returns (stream Item);
  rpc GetItem(GetItemRequest) returns (Item) {
    option (google.api.http) = { get: "/v1/{name=items/*}" };
  }
  rpc UpdateItem (UpdateItemRequest) returns (Item) {
    option (google.api.http) = {
      patch: "/v1/items/{item.id}"
      body: "item"
    };
  }
}

message ListItemsRequest { int32 page_size = 1; string page_token = 2; }
message GetItemRequest { string name = 1; }
message UpdateItemRequest { Item item = 1; google.protobuf.FieldMask update_mask = 2; }
message Item {
  reserved 3, 4;
  string id = 1;
  map<string, int64> stock = 2;
  oneof price { int64 cents = 5; string free_text = 6; }
  repeated Tag tags = 7;
  message Tag { string label = 1; }
  enum Kind { KIND_UNSPECIFIED = 0; BOOK = 1; }
  Kind kind = 8;
}
`.split("\n");

describe("protobuf services", () => {
  it("one contract row per rpc at its gRPC path, and its grpc-gateway binding as a REST row", () => {
    const rows = extractProtoRoutes(PROTO).map((r) => `${r.httpMethod} ${r.path} ${r.handler} ${r.contract?.type} ${r.params?.[0]?.type ?? "-"} @${r.line}`);
    expect(rows).toEqual([
      "POST /shop.v1.Catalog/ListItems ListItems shop.v1.Catalog ListItemsRequest @6",
      "POST /shop.v1.Catalog/GetItem GetItem shop.v1.Catalog GetItemRequest @7",
      "GET /v1/{name} GetItem shop.v1.Catalog - @8",
      "POST /shop.v1.Catalog/UpdateItem UpdateItem shop.v1.Catalog UpdateItemRequest @10",
      "PATCH /v1/items/{item.id} UpdateItem shop.v1.Catalog UpdateItemRequest @11",
    ]);
  });
});

describe("protobuf messages", () => {
  it("fields with repeated, map and oneof spellings; nested messages by their own name; no enum or reserved field", () => {
    const classes = extractProtoMessages(PROTO);
    expect(classes.map((c) => c.name)).toEqual(["ListItemsRequest", "GetItemRequest", "UpdateItemRequest", "Item", "Tag"]);
    const item = classes.find((c) => c.name === "Item")!;
    expect(item.properties.map((p) => `${p.name}:${p.type}`)).toEqual([
      "id:string", "stock:map<string,int64>", "cents:int64", "free_text:string", "tags:Tag[]", "kind:Kind",
    ]);
    expect(item.decorators).toEqual(["protobuf-message"]);
  });

  it("reads field types the way proto3's JSON mapping writes them", () => {
    expect(protobufRequestSchema.describeType("int64")).toEqual({ kind: "scalar", schema: { type: "string", format: "int64" } });
    expect(protobufRequestSchema.describeType("Tag[]")).toEqual({ kind: "array", element: "Tag" });
    expect(protobufRequestSchema.describeType("map<string,int64>")).toEqual({ kind: "map", value: "int64" });
    expect(protobufRequestSchema.describeType("shop.v1.Item")).toEqual({ kind: "object", name: "Item" });
    expect(protobufRequestSchema.describeType("google.protobuf.Timestamp")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(protobufRequestSchema.serializedName!({ name: "page_size" } as never)).toBe("pageSize");
  });
});
