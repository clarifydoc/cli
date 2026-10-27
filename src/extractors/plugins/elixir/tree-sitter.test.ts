import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { loadElixirReader } from "./tree-sitter.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ParsedStructure } from "../../../types/language-plugin.js";

let readElixir: (source: string) => ParsedStructure;
beforeAll(async () => {
  readElixir = await loadElixirReader();
});

const CLUBS = `defmodule League.Clubs do
  use Ecto.Schema
  alias League.Repo

  schema "clubs" do
    field :name, :string
  end

  def get_club!(id), do: Repo.get!(Club, id)

  def create_club(attrs) when is_map(attrs) do
    %Club{}
    |> Club.changeset(attrs)
    |> Repo.insert()
    |> notify(:created)
  end

  defp notify({:ok, club} = result, event) do
    League.Mailer.deliver_later! build_email(club, event)
    Enum.each(club.players, fn p -> Squad.notify_player(p) end)
    socket.assigns.user
    result
  end
end
`;

describe("Elixir through tree-sitter", () => {
  it("reads each def clause with its exact span, including its end", () => {
    const parsed = readElixir(CLUBS);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["get_club!", 9, 9],
      ["create_club", 11, 16],
      ["notify", 18, 23],
    ]);
  });

  it("names calls ending in ! or ?, remote calls without parentheses, and calls in anonymous functions", () => {
    const calls = (name: string) => readElixir(CLUBS).functions.find((f) => f.name === name)!.calls.map((c) => c.name);
    expect(calls("get_club!")).toEqual(["Repo.get!"]);
    // A guard runs when the function is called: its calls are the function's.
    expect(calls("create_club")).toEqual(["is_map", "Club.changeset", "Repo.insert", "notify"]);
    // A field read (`socket.assigns.user`) is no call; `Enum.each` is stdlib noise, held back as the patterns hold it.
    expect(calls("notify")).toEqual(["Mailer.deliver_later!", "build_email", "Squad.notify_player"]);
  });

  it("reads a head's default arguments and guard, never its own name (real-repo FP)", () => {
    const fn = readElixir(`defmodule A do\n  def create(steps, status \\\\ Status.pending()) when length(steps) in Fixture.min_legs()..Fixture.max_legs() do\n    steps\n  end\nend\n`).functions[0]!;
    expect(fn.calls.map((c) => c.name)).toEqual(["Status.pending", "length", "Fixture.min_legs", "Fixture.max_legs"]);
  });

  it("names no DSL macro, sigil word or SQL in a string, and reads a template's calls (real-repo FP)", () => {
    const calls = (body: string) => readElixir(`defmodule A do\n  def f(assigns) do\n${body}\n  end\nend\n`).functions[0]!.calls.map((c) => c.name);
    expect(calls('    get "/clubs", ClubController, :index')).toEqual([]);
    expect(calls('    positions = ~w(keeper defender)\n    Repo.query!("SELECT count(*) FROM clubs WHERE id IN (1)")')).toEqual(["Repo.query!"]);
    expect(calls('    ~H"""\n    <div phx-click={show_modal("lineup")}><%= render_slot(@inner_block) %></div>\n    """')).toEqual(["show_modal", "render_slot"]);
    // An interpolation inside an attribute value is code.
    expect(calls('    ~H"""\n    <a title={"Kick-off #{format_kickoff(@match.starts_at)}"} href={~p"/matches?#{[round: Rounds.current()]}"}>x</a>\n    """')).toEqual(["format_kickoff", "Rounds.current"]);
  });

  it("counts the errors of a file the grammar cannot read, so core keeps the regex reading", () => {
    expect(readElixir("defmodule A do\n  def f(x do\nend\n").syntaxErrors).toBeGreaterThan(0);
  });
});

/**
 * Where the two readings of a fixture differ, and why the parser's is the one to keep: `file → function →
 * [calls only the patterns record, calls only the parser records]`. The patterns cannot read a name ending in `!`
 * (`Repo.get!(`). Extents differ throughout and are not listed: the patterns end a function on its last indented
 * line, the parser on its `end`.
 */
const KNOWN: Record<string, Record<string, [string[], string[]]>> = {
  "test-fixtures/sample-elixir-app/lib/my_app/clubs.ex": {
    "MyApp.Clubs.get_player!": [[], ["Repo.get!"]],
  },
  "test-fixtures/sample-elixir-app/lib/my_app_web/player_controller.ex": {
    "MyAppWeb.PlayerController.show": [[], ["Clubs.get_player!"]],
  },
};

describe("Elixir: tree-sitter and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/**/*.{ex,exs}", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do, but where it is listed as better`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readElixir(src);
      expect(parsed.syntaxErrors).toBe(0);
      const shape = (a: ReturnType<typeof extractWithRegex>) => [
        ...a.functions.map((f) => ({ name: f.name, line: f.line, calls: f.calls.map((c) => c.name) })),
        ...a.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, calls: m.calls.map((x) => x.name) }))),
      ];
      const regex = shape(extractWithRegex(src, rel, "elixir"));
      const tree = shape(extractWithRegex(src, rel, "elixir", undefined, parsed));
      expect(tree.map(({ calls: _, ...fn }) => fn)).toEqual(regex.map(({ calls: _, ...fn }) => fn));
      const differences: Record<string, [string[], string[]]> = {};
      regex.forEach((fn, i) => {
        const b = tree[i]!.calls;
        const onlyA = fn.calls.filter((c) => !b.includes(c));
        const onlyB = b.filter((c) => !fn.calls.includes(c));
        if (onlyA.length + onlyB.length > 0) differences[fn.name] = [onlyA, onlyB];
      });
      expect(differences).toEqual(KNOWN[rel] ?? {});
    });
  }
});
