import { describe, it, expect } from "vitest";
import { extractElixirImports } from "./index.js";

describe("elixir imports", () => {
  it("names each module by what the file calls it: last segment, `as:`, multi-alias members", () => {
    const src = `defmodule League.Auth.SSO do
  alias League.Auth.PlayerSessions
  alias League.Billing.Plans, as: P
  alias League.{Repo, Teams.Membership}
  alias PlausibleWeb.{
    Router,
    # a comment
    Endpoint
  }
  import Ecto.Query
end`;
    expect(extractElixirImports(src.split("\n")).map((i) => [i.source, i.specifiers[0]])).toEqual([
      ["League.Auth.PlayerSessions", "PlayerSessions"],
      ["League.Billing.Plans", "P"],
      ["League.Repo", "Repo"],
      ["League.Teams.Membership", "Membership"],
      ["PlausibleWeb.Router", "Router"],
      ["PlausibleWeb.Endpoint", "Endpoint"],
      ["Ecto.Query", "Query"],
    ]);
  });

  it("puts an import's functions in scope — every one, or those `only:` names", () => {
    const src = `defmodule League.Referee do
  import League.Rules
  import League.Cards, only: [book: 2, send_off: 1]
  import League.Var,
    only: [
      review?: 1
    ]
  alias League.Clubs
end`;
    expect(extractElixirImports(src.split("\n")).map((i) => i.inScope)).toEqual([
      { module: "League.Rules" },
      { module: "League.Cards", names: ["book", "send_off"] },
      { module: "League.Var", names: ["review?"] },
      undefined,
    ]);
  });
});
