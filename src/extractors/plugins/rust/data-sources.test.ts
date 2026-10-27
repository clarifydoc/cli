import { describe, it, expect } from "vitest";
import { extractRustDataSources } from "./data-sources.js";

describe("Rust HTTP calls", () => {
  it("follow a client's chain onto the next line, and a format! URL in a local (real-repo FP)", () => {
    const src = `async fn request_quote(count: u32) -> Result<f64, anyhow::Error> {
    let client = awc::Client::new();
    let quote_addr: String = format!(
        "{}{}",
        env::var("QUOTE_ADDR")
            .unwrap_or_else(|_| "http://quote:8090".to_string()),
        "/getquote"
    );
    let mut response = client
        .post(quote_addr)
        .send_json(&body)
        .await?;
    let plain = "https://garage.example.com/cars";
    let cars = reqwest_client.get(plain).send().await?;
}`;
    const calls = extractRustDataSources(src.split("\n")).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => `${c.name} ${c.target} @${c.line}`)).toEqual([
      'POST ${env::var("QUOTE_ADDR").unwrap_or_else(|_|"http://quote:8090".to_string())}/getquote @10',
      "GET https://garage.example.com/cars @14",
    ]);
  });
});

describe("Rust HTTP calls through a client getter", () => {
  it("read `ctx.client().get(url)` and a chain whose client getter ends the line above (real-repo FP)", () => {
    const src = `async fn fetch_fixtures(context: &Context) -> Result<()> {
    let fixtures_url = "https://league.example.com/fixtures";
    let res = context.client().get(fixtures_url).send().await?;
    let purge_url = format!("{}/purge", "https://garage.example.com");
    context
      .garage_client()
      .post(&purge_url)
      .send()
      .await?;
}`;
    const calls = extractRustDataSources(src.split("\n")).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => `${c.name} ${c.target} @${c.line}`)).toEqual([
      "GET https://league.example.com/fixtures @3",
      "POST https://garage.example.com/purge @7",
    ]);
  });
});

describe("Rust Diesel tables", () => {
  it("read a table a dsl import names, and mark inserts, updates and deletes as writes (real-repo FP)", () => {
    const src = `use league_schema::{
  schema::{
    club::dsl::club,
    club_badge::dsl::{club_id, club_badge},
  },
};

impl Crud for Club {
  async fn create(pool: &mut DbPool<'_>, form: &ClubForm) -> Result<Self> {
    insert_into(club)
      .values(form)
      .get_result::<Self>(conn)
  }
  async fn update(pool: &mut DbPool<'_>, id: ClubId, form: &ClubForm) -> Result<Self> {
    diesel::update(club.find(id)).set(form).get_result::<Self>(conn)
  }
  async fn drop_badges(pool: &mut DbPool<'_>, id: ClubId) -> Result<usize> {
    diesel::delete(club_badge.filter(club_id.eq(id))).execute(conn)
  }
  async fn badges(pool: &mut DbPool<'_>, id: ClubId) -> Result<Vec<Badge>> {
    let badges = club_badge.filter(club_id.eq(id)).load(conn);
    badges
  }
  async fn release(pool: &mut DbPool<'_>, id: PlayerId) -> Result<usize> {
    delete(
      player::table.filter(player::id.eq(id)),
    )
    .execute(conn)
  }
}`;
    const rows = extractRustDataSources(src.split("\n")).filter((d) => d.kind === "database");
    expect(rows.map((r) => `${r.name} ${r.target} ${r.access} @${r.line}`)).toEqual([
      "diesel: insert_into club write @10",
      "diesel: update club write @15",
      "diesel: delete club_badge write @18",
      "diesel club_badge read @21",
      "diesel: delete player write @26",
    ]);
  });

  it("read a table named through its dsl module, qualified or imported", () => {
    const src = `use garage_db::schema::car_table;
use garage_db::schema::car_table::dsl;

pub fn update_car(conn: &mut Conn, changeset: CarChangeset) -> Result<()> {
  diesel::update(dsl::car_table)
    .filter(car_table::id.eq(changeset.id))
    .execute(conn)?;
}
pub fn select_car(conn: &mut Conn, id: &str) -> Result<Car> {
  let car = dsl::car_table.filter(dsl::id.eq(id)).first::<Car>(conn)?;
  diesel::delete(engine_table::dsl::engine_table.filter(engine_table::car_id.eq(id))).execute(conn)?;
}`;
    const rows = extractRustDataSources(src.split("\n")).filter((d) => d.kind === "database");
    expect(rows.map((r) => `${r.name} ${r.target} ${r.access} @${r.line}`)).toEqual([
      "diesel: update car_table write @5",
      "diesel car_table read @10",
      "diesel: delete engine_table write @11",
    ]);
  });

  it("read the table a query's column paths name when its source comes from a helper (real-repo FP)", () => {
    const src = `use league_schema_file::schema::{match_report, club_actions};
use league_views_sql::match_report_joins;

impl MatchReportView {
  pub async fn read(pool: &mut DbPool<'_>, id: MatchReportId) -> Result<Self> {
    let res = match_report_joins(id)
      .filter(match_report::id.eq(id))
      .filter(match_report::resolved.eq(false))
      .select(MatchReportView::as_select())
      .first(conn)
      .await?;
    res
  }
  pub fn from_cursor(query: Query, kind: char, id: i32) -> Query {
    match kind {
      'C' => query.filter(match_report::club_report_id.eq(id)),
      _ => query.filter(club_actions::club_id.eq(id)),
    }
  }
}`;
    const rows = extractRustDataSources(src.split("\n")).filter((d) => d.kind === "database");
    expect(rows.map((r) => `${r.name} ${r.target} ${r.access} @${r.line}`)).toEqual([
      "diesel match_report read @7",
      "diesel match_report read @16",
      "diesel club_actions read @17",
    ]);
  });

  it("read the table an aliased dsl module stands for (real-repo FP)", () => {
    const src = `fn limit_kits(conn: &mut Conn, league: LeagueId) {
    use league_schema_file::schema::{
      club::dsl as c,
      club_kit::dsl as ck,
    };
    let kits: Vec<KitId> = ck::club_kit
      .inner_join(c::club)
      .filter(c::league_id.eq(league))
      .select(ck::kit_id)
      .get_results(conn);
}`;
    const rows = extractRustDataSources(src.split("\n")).filter((d) => d.kind === "database");
    expect(rows.map((r) => r.entity)).toEqual(expect.arrayContaining(["club_kit"]));
    expect(rows.some((r) => r.entity === "ck" || r.entity === "c")).toBe(false);
  });
});
