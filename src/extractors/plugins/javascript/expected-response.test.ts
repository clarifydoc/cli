import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";

const fieldsOf = async (src: string) => {
  const tree = await parseSource(src, "typescript" as any, "club.ts");
  return new JavaScriptDataSourceExtractor()
    .extract(tree, src)
    .filter((d) => d.kind === "api-call")
    .map((d) => `${d.target} [${(d.expectedResponseFields ?? []).join(",") || "-"}]`);
};

describe("expected response fields on an api-call", () => {
  it("reads required members of axios.get<T> and a typed json local; Partial and optional stay quiet; Garage unused", async () => {
    expect(await fieldsOf(`
interface ClubDto { crest: string; badge: string }
interface SoftClub { crest?: string; badge?: string }
interface GarageDto { bay: number; lift: boolean }
import axios from "axios";
export async function loadClub(id: string) {
  const { data } = await axios.get<ClubDto>(\`/clubs/\${id}\`);
  return data.crest;
}
export async function loadSoft(id: string) {
  const { data } = await axios.get<SoftClub>(\`/clubs/\${id}\`);
  return data?.crest;
}
export async function loadPartial(id: string) {
  const { data } = await axios.get<Partial<ClubDto>>(\`/clubs/\${id}\`);
  return data.crest;
}
export async function loadTyped(id: string) {
  const res = await fetch(\`/clubs/\${id}\`);
  const body: ClubDto = await res.json();
  return body.crest;
}
`)).toEqual([
      "/clubs/${id} [badge,crest]",
      "/clubs/${id} [-]",
      "/clubs/${id} [-]",
      "/clubs/${id} [badge,crest]",
    ]);
  });
});
