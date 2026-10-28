import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import { grapeMounts } from "./grape.js";

const rb = (src: string, path: string): FileAnalysis => extractWithRegex(src, path, "ruby");
const sig = (a: FileAnalysis): string[] => a.routes.map((r) => `${r.httpMethod} ${r.path} @${r.line}`);
const resolve = (files: FileAnalysis[]): void => grapeMounts.resolve(files, {} as ProjectContext);

describe("Grape endpoints", () => {
  const clubs = `module League
  class ClubsAPI < Grape::API
    version 'v1', using: :path
    format :json
    prefix :api

    helpers do
      def current_manager
        get_manager(headers['Token'])
      end
    end

    resource :clubs do
      desc 'List clubs'
      get do
        Club.all
      end

      params do
        requires :name, type: String
        optional :league_id, type: Integer
        optional :kit, type: Hash do
          requires :colour, type: String
        end
      end
      post do
        Club.create!(name: params[:name])
      end

      route_param :id do
        get do
          Club.find(params[:id])
        end
        put do
          Club.find(params[:id]).update(params)
        end
        namespace 'players/:number' do
          delete do
            Player.find_by(number: params[:number]).destroy
          end
        end
      end
    end
  end
end`;

  it("reads the nested scopes into full paths under the prefix and path version", () => {
    const a = rb(clubs, "app/api/clubs_api.rb");
    expect(sig(a)).toEqual([
      "GET /api/v1/clubs @15",
      "POST /api/v1/clubs @26",
      "GET /api/v1/clubs/:id @31",
      "PUT /api/v1/clubs/:id @34",
      "DELETE /api/v1/clubs/:id/players/:number @38",
    ]);
    expect(a.routes.every((r) => r.owner === "League::ClubsAPI" && r.handler === null)).toBe(true);
    expect(a.routes[0]!.versions).toEqual(["v1"]);
  });

  it("gives each endpoint its block's calls and the params block above it", () => {
    const a = rb(clubs, "app/api/clubs_api.rb");
    const show = a.routes.find((r) => r.path === "/api/v1/clubs/:id" && r.httpMethod === "GET")!;
    expect(show.calls.map((c) => `${c.name}@${c.line}`)).toContain("Club.find@32");
    const create = a.routes.find((r) => r.httpMethod === "POST")!;
    expect(create.params?.map((p) => `${p.name}:${p.type ?? "-"}:${p.binding}`)).toEqual(["name:String:body", "league_id:Integer:body", "kit:Hash:body"]);
    // The params block belongs to the next endpoint only.
    expect(a.routes.find((r) => r.path === "/api/v1/clubs/:id" && r.httpMethod === "PUT")!.params?.map((p) => p.name)).toEqual(["id"]);
  });

  it("guards the endpoints after a before block in its scope, and reads a header version as no path segment", () => {
    const a = rb(`class Garages < Grape::API
  version 'v2', using: :header, vendor: 'league'
  get :status do
    { ok: true }
  end
  namespace :garages do
    before do
      authenticate!
    end
    get do
      Garage.all
    end
  end
end`, "app/api/garages.rb");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} ${r.middleware.join(",") || "-"} ${r.versions?.join(",")}`)).toEqual([
      "GET /status - v2",
      "GET /garages authenticate! v2",
    ]);
    expect(a.routes[1]!.auth?.policies).toEqual(["authenticate!"]);
  });

  it("reads nothing from a file without a Grape API", () => {
    expect(rb(`class Report\n  def get\n    resource :x do\n    end\n  end\nend`, "app/models/report.rb").routes).toEqual([]);
  });
});

describe("Grape mounts", () => {
  const router = rb(`Rails.application.routes.draw do
  mount League::Root => '/'
  mount Sidekiq::Web => '/sidekiq'
end`, "config/routes.rb");
  const root = () => rb(`module League
  class Root < Grape::API
    prefix 'api'
    before do
      authenticate!
    end
    mount V1::Base
    namespace :admin do
      mount Admin::Garages
    end
  end
end`, "app/api/league/root.rb");
  const v1 = () => rb(`module League
  module V1
    class Base < Grape::API
      version 'v1', using: :path
      mount Clubs
      mount ::League::V1::Players => '/squad'
    end
  end
end`, "app/api/league/v1/base.rb");
  const clubs = () => rb(`module League
  module V1
    class Clubs < Grape::API
      resource :clubs do
        route_param :id do
          get do
            Club.find(params[:id])
          end
        end
      end
    end
  end
end`, "app/api/league/v1/clubs.rb");
  const players = () => rb(`module League
  module V1
    class Players < Grape::API
      get :players do
        Player.all
      end
    end
  end
end`, "app/api/league/v1/players.rb");
  const garages = () => rb(`module League
  module Admin
    class Garages < Grape::API
      version 'v9', using: :path
      get :garages do
        Garage.all
      end
    end
  end
end`, "app/api/league/admin/garages.rb");

  it("serves a mounted API under the mount path, prefix, version and namespace of the APIs that mount it", () => {
    const files = [router, root(), v1(), clubs(), players(), garages()];
    resolve(files);
    // Grape orders a path mount path, prefix, version, namespace; an API's own version wins over the inherited one.
    expect(files.flatMap(sig).sort()).toEqual([
      "GET /api/v1/clubs/:id @6",
      "GET /api/v9/admin/garages @5",
      "GET /squad/api/v1/players @4",
    ]);
  });

  it("carries the mounting API's guards onto the mounted endpoints", () => {
    const files = [router, root(), v1(), clubs()];
    resolve(files);
    const show = files[3]!.routes[0]!;
    expect(show.middleware).toEqual(["authenticate!"]);
    expect(show.auth?.policies).toEqual(["authenticate!"]);
    expect(show.versions).toEqual(["v1"]);
  });

  it("leaves an API nothing mounts at its own paths", () => {
    const files = [clubs()];
    resolve(files);
    expect(files.flatMap(sig)).toEqual(["GET /clubs/:id @6"]);
  });
});
