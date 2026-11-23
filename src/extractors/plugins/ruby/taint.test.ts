import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

async function findings(src: string, rel = "app/controllers/clubs_controller.rb"): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "rb-taint-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "rb-taint-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "ruby" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: out, pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return (result!.analysis.securityIssues ?? []).filter((i) => i.message.startsWith("Request input")).map((i) => `${i.line} ${i.category}`);
}


describe("handler taint — Ruby (Rails, Sinatra)", () => {
  it("follows params into SQL text, commands, reflection, paths, URLs and redirects", async () => {
    expect(await findings(`class ClubsController < ApplicationController
  def index
    q = params[:q]
    Club.where("name = '#{q}'")
    Club.find_by_sql("SELECT * FROM clubs WHERE id = " + params[:id])
  end

  def export
    system "export --club #{params[:club]}"
    \`tar cf out.tar #{params[:dir]}\`
    player.send(params[:action_name])
    File.read(File.join("/data", params[:file]))
    redirect_to params[:return_to]
    Net::HTTP.get(URI(params[:feed]))
    redirect_to "https://#{params[:to]}"
    return unless ALLOWED.include?(params["sort"])
    Club.where("x = #{params["name"]}")
  end
end
`)).toEqual(["4 sql-injection", "5 sql-injection", "9 command-injection", "10 command-injection", "11 eval-exec", "12 path-traversal", "13 open-redirect", "14 ssrf", "15 open-redirect", "17 sql-injection"]);
  });

  it("follows input into a Sinatra route and a controller's private helper", async () => {
    expect(await findings(`get "/clubs" do
  Club.where("name = '#{params[:name]}'")
end

class PlayersController < ApplicationController
  private

  def lookup
    Player.where("id = #{params[:id]}")
  end
end
`, "app/clubs.rb")).toEqual(["2 sql-injection", "9 sql-injection"]);
  });

  it("leaves bound parameters, hashes, casts, quoted values and checked values alone", async () => {
    expect(await findings(`class ClubsController < ApplicationController
  def index
    Club.where(name: params[:name])
    Club.where("name = ?", params[:name])
    Club.where("id = #{params[:id].to_i}")
    Club.where("name = #{Club.connection.quote(params[:name])}")
    Club.where("id = #{Integer(params[:id])}")
    Club.where("n = #{Club.sanitize_sql_like(params[:n])}")
    system("git", "log", params[:branch])
    system("date")
    File.read(File.join("/data", File.basename(params[:file])))
    redirect_to controller: "clubs", id: params[:id]
    redirect_to root_url + params[:path]
    Club.order(params[:sort])
  end

  def sort
    col = params[:sort]
    return unless %w[name city].include?(col)
    Club.where("#{col} IS NOT NULL")
  end

  def back
    url = params[:next]
    redirect_to "/" unless url.start_with?("/")
    redirect_to url
  end

  def guarded
    return unless ALLOWED.include?(params[:step])
    send("go_#{params[:step]}")
  end

  def mobile
    params = { email: "x" }.to_query
    base = Settings.load("BASE")
    redirect_to "#{base}://auth?#{params}"
  end

  def locale
    head :ok if Club.exists?(params[:id])
    redirect_to club_locale_path(@club.slug, params[:locale])
    redirect_to "#{root_url}clubs/#{params[:id]}"
  end

  def helper_class
    Club.where("n = #{clean_name(params[:n])}")
  end
end

class ClubReport
  def run(name)
    Club.where("name = '#{name}'")
  end
end
`)).toEqual([]);
  });

  it("does not parse a file that never reads request input, nor one with syntax errors", async () => {
    expect(await findings(`class ClubReport
  def run(name)
    Club.where("name = '#{name}'")
  end
end
`, "app/models/club_report.rb")).toEqual([]);
    expect(await findings(`class ClubsController < ApplicationController
  def index
    Club.where("n = #{params[:n]}"
`)).toEqual([]);
  });
  it("reads interpolation inside a heredoc that reaches a SQL sink", async () => {
    expect(await findings(`class ClubsController < ApplicationController
  def index
    Club.find_by_sql(<<~SQL)
      SELECT * FROM clubs WHERE name = '#{params[:name]}'
    SQL
  end

  def reset
    sql = <<-SQL
      DELETE FROM players WHERE club = '#{params[:club]}'
    SQL
    ActiveRecord::Base.connection.execute(sql)
    ActiveRecord::Base.connection.execute(<<~SQL, 1)
      UPDATE players SET name = '#{params[:name]}'
    SQL
  end

  def safe
    Club.find_by_sql(<<~SQL)
      SELECT * FROM clubs WHERE id = #{params[:id].to_i}
    SQL
    Club.find_by_sql(<<~'SQL')
      SELECT '#{params[:id]}'
    SQL
    Club.find_by_sql(<<~SQL)
      SELECT * FROM clubs WHERE league = '#{LEAGUE}'
    SQL
    Club.logger.debug(<<~SQL)
      #{params[:id]}
    SQL
  end
end
`)).toEqual(["3 sql-injection", "12 sql-injection", "13 sql-injection"]);
  });
  it("reads a heredoc chained into text-keeping calls, never one a conversion ends", async () => {
    expect(await findings(`class ClubsController < ApplicationController
  def index
    ActiveRecord::Base.connection.execute(<<~SQL.strip)
      SELECT * FROM clubs WHERE name = '#{params[:name]}'
    SQL
  end

  def squished
    Club.find_by_sql(<<~SQL.squish.freeze)
      SELECT * FROM clubs WHERE name = '#{params[:name]}'
    SQL
  end

  def safe
    name = params[:name]
    ActiveRecord::Base.connection.execute(<<~SQL.strip)
      SELECT * FROM clubs WHERE id = #{Integer(name)}
    SQL
    ActiveRecord::Base.connection.execute(<<~SQL.strip)
      SELECT * FROM clubs WHERE active = 1
    SQL
    Club.find_by_sql(<<~SQL.to_i)
      #{params[:name]}
    SQL
  end
end
`)).toEqual(["3 sql-injection", "9 sql-injection"]);
  });
});
