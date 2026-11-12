import { describe, it, expect } from "vitest";
import { snakeColumn, tagColumn } from "./struct-columns.js";

describe("Go struct member columns", () => {
  it("applies the mapper convention with initialisms as one word", () => {
    expect(["ID", "OtherClubID", "HTTPServer", "LeagueURLPath", "Name", "Season2"].map(snakeColumn)).toEqual([
      "id", "other_club_id", "http_server", "league_url_path", "name", "season2",
    ]);
  });

  it("reads the column a tag names, and opt-outs", () => {
    const col = (...decorators: string[]) => tagColumn({ decorators });
    expect(col(`xorm:"'club_id' pk autoincr"`)).toBe("club_id");
    expect(col(`xorm:"league_ref index"`)).toBe("league_ref");
    expect(col(`xorm:"VARCHAR(100)"`)).toBeUndefined();
    expect(col(`xorm:"pk autoincr"`)).toBeUndefined();
    expect(col(`gorm:"primaryKey;column:club_id"`)).toBe("club_id");
    expect(col(`orm:"column(club_id)"`)).toBe("club_id");
    expect(col(`json:"clubId"`)).toBeUndefined();
    expect(col(`xorm:"-"`)).toBeNull();
  });
});
