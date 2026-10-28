import { describe, it, expect } from "vitest";
import { mapperDataSources } from "./mybatis.js";

describe("mapperDataSources", () => {
  it("reads every table a statement names through the shared SQL reader", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="league.ClubMapper">
  <select id="standings">SELECT c.name FROM clubs c JOIN standings s ON s.club_id = c.id</select>
  <update id="promote">UPDATE clubs SET tier = 1 WHERE id IN (SELECT club_id FROM promotions)</update>
</mapper>`;
    expect(mapperDataSources(xml.split("\n")).map((d) => `${d.line} ${d.name} ${d.target} ${d.access}${d.joined ? " joined" : ""}`)).toEqual([
      "3 <select> clubs read",
      "3 <select> standings read joined",
      "4 <update> clubs write",
      "4 <select> promotions read joined",
    ]);
  });
});
