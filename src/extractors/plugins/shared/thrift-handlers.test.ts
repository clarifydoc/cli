import { describe, it, expect } from "vitest";
import { thriftHandlerFacts } from "./thrift-handlers.js";

const handlers = (text: string): string[] => thriftHandlerFacts(text, "go").map((f) => (f.data as { handler: string }).handler);

describe("Go thrift handler names", () => {
  it("strips New only from a constructor call", () => {
    expect(handlers("p := NewClubServiceProcessor(NewClubHandler())")).toEqual(["ClubHandler"]);
    expect(handlers("p := NewClubServiceProcessor(&clubHandler{})")).toEqual(["clubHandler"]);
  });
  it("keeps a type whose name merely starts with New", () => {
    expect(handlers("p := NewClubServiceProcessor(&NewsHandler{})")).toEqual(["NewsHandler"]);
    expect(handlers("p := NewClubServiceProcessor(Newton{})")).toEqual(["Newton"]);
    expect(handlers("h := &NewsHandler{}\np := NewClubServiceProcessor(h)")).toEqual(["NewsHandler"]);
    expect(handlers("h := NewNewsHandler()\np := NewClubServiceProcessor(h)")).toEqual(["NewsHandler"]);
  });
});
