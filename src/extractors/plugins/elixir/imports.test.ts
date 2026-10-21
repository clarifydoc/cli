import { describe, it, expect } from "vitest";
import { extractElixirImports } from "./index.js";

describe("elixir imports", () => {
  it("names each module by what the file calls it: last segment, `as:`, multi-alias members", () => {
    const src = `defmodule Plausible.Auth.SSO do
  alias Plausible.Auth.PlayerSessions
  alias Plausible.Billing.Plans, as: P
  alias Plausible.{Repo, Teams.Membership}
  alias PlausibleWeb.{
    Router,
    # a comment
    Endpoint
  }
  import Ecto.Query
end`;
    expect(extractElixirImports(src.split("\n")).map((i) => [i.source, i.specifiers[0]])).toEqual([
      ["Plausible.Auth.PlayerSessions", "PlayerSessions"],
      ["Plausible.Billing.Plans", "P"],
      ["Plausible.Repo", "Repo"],
      ["Plausible.Teams.Membership", "Membership"],
      ["PlausibleWeb.Router", "Router"],
      ["PlausibleWeb.Endpoint", "Endpoint"],
      ["Ecto.Query", "Query"],
    ]);
  });
});
