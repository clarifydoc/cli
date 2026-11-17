import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { haltsCaller } from "./route-meta.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("haltsCaller — a filter body that stops an unauthorized caller", () => {
  it("reads head, render status, raise and a sign-in redirect", () => {
    expect(haltsCaller(["  head :forbidden unless current_user&.member?"])).toBe(true);
    expect(haltsCaller(['  render json: {}, status: :unauthorized unless request.headers["X-Key"]'])).toBe(true);
    expect(haltsCaller(["  render json: {}, status: 403 unless current_user.admin?"])).toBe(true);
    expect(haltsCaller(["  raise Pundit::NotAuthorizedError unless current_user.crew?"])).toBe(true);
    expect(haltsCaller(["  redirect_to new_session_path unless current_user"])).toBe(true);
    expect(haltsCaller(["  unless current_user", "    redirect_to new_session_path", "  end"])).toBe(true);
  });
  it("does not read a loader, a 404 or an ordinary redirect", () => {
    expect(haltsCaller(["  @club = Club.find(params[:id])"])).toBe(false);
    expect(haltsCaller(["  render json: {}, status: 404 unless Car.exists?"])).toBe(false);
    expect(haltsCaller(["  redirect_to clubs_path if params[:done]"])).toBe(false);
    // A 403 for a condition that does not test the caller (a plan gate, a bad parameter) is no check on who calls.
    expect(haltsCaller(["  render json: {}, status: :forbidden unless Feature.on?(:companies)"])).toBe(false);
    expect(haltsCaller(["  head :forbidden if params[:member_id].blank?"])).toBe(false);
  });
});

describe("haltsCaller — the condition must test who the caller is", () => {
  it("reads a caller check with the halting polarity", () => {
    expect(haltsCaller(["  head :unauthorized unless current_user"])).toBe(true);
    expect(haltsCaller(["  render json: { error: 'no' }, status: :forbidden unless current_user.admin?"])).toBe(true);
    expect(haltsCaller(["  raise NotAuthorized unless can?(:manage, @club)"])).toBe(true);
    expect(haltsCaller(["  redirect_to login_path unless logged_in?"])).toBe(true);
    expect(haltsCaller(["  head :unauthorized if current_user.nil?"])).toBe(true);
    expect(haltsCaller(["  head :unauthorized if !session[:player_id]"])).toBe(true);
    expect(haltsCaller(["  head :forbidden unless @club.owner == current_user"])).toBe(true);
    expect(haltsCaller(["  unless current_user", "    head :unauthorized", "  end"])).toBe(true);
    expect(haltsCaller(["  if current_user.admin?", "    @club = Club.first", "  else", "    head :forbidden", "  end"])).toBe(true);
  });
  it("reads a guard clause that returns for a permitted caller and halts for the rest", () => {
    expect(haltsCaller(["  return if current_user&.admin?", "  head :forbidden"])).toBe(true);
  });
  it("rejects a halt that does not follow from the caller check failing", () => {
    expect(haltsCaller(["  render json: { error: 'x' }, status: :unauthorized if params[:page].blank?"])).toBe(false);
    expect(haltsCaller(["  head :unauthorized unless Pit.on?"])).toBe(false);
    expect(haltsCaller(["  raise Forbidden unless Club.open?"])).toBe(false);
    expect(haltsCaller(["  redirect_to dashboard_path if current_user.present?"])).toBe(false);
    expect(haltsCaller(["  if @club.archived?", "    render status: :unauthorized", "  end"])).toBe(false);
    expect(haltsCaller(["  head :forbidden unless current_user.active?"])).toBe(false);
    expect(haltsCaller(["  redirect_to root_path unless current_user.active?"])).toBe(false);
  });
  it("rejects an unconditional halt, a nested condition and a wrong-polarity guard clause", () => {
    expect(haltsCaller(["  head :unauthorized"])).toBe(false);
    expect(haltsCaller(["  if @club.archived?", "    head :unauthorized unless current_user", "  end"])).toBe(false);
    expect(haltsCaller(["  unless current_user", "    if params[:x]", "      head :unauthorized", "    end", "  end"])).toBe(false);
    expect(haltsCaller(["  return if params[:skip]", "  head :forbidden"])).toBe(false);
    expect(haltsCaller(["  @club = Club.first", "  return if current_user&.admin?", "  head :forbidden"])).toBe(false);
    expect(haltsCaller(["  if current_user.admin?", "    head :forbidden", "  end"])).toBe(false);
  });
});

describe("a before_action whose body halts is a guard whatever its name", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-halt-"));
    const files: Record<string, string> = {
      Gemfile: 'source "https://rubygems.org"\n',
      "config/routes.rb": "Rails.application.routes.draw do\n  resources :cars, only: [:index]\n  resources :garages, only: [:index]\n  resources :pits, only: [:index]\n  resources :switch, only: [:index]\n  resources :clubs, only: [:index]\nend\n",
      "app/controllers/application_controller.rb":
        "class ApplicationController < ActionController::Base\n  before_action :club_gate\n\n  private\n\n  def club_gate\n    head :forbidden unless current_user&.member?\n  end\nend\n",
      "app/controllers/clubs_controller.rb": "class ClubsController < ApplicationController\n  def index; end\nend\n",
      "app/controllers/cars_controller.rb":
        "class CarsController < ActionController::Base\n  before_action :check_garage\n  before_action :load_car\n\n  def index; end\n\n  private\n\n  def check_garage\n    render json: {}, status: :unauthorized unless request.headers['X-Key']\n  end\n\n  def load_car\n    render json: {}, status: 404 unless Car.exists?\n  end\nend\n",
      "app/controllers/garages_controller.rb": "class GaragesController < ActionController::Base\n  include Pitwall\n  before_action :check_pit\n\n  def index; end\nend\n",
      "app/controllers/concerns/pitwall.rb":
        "module Pitwall\n  extend ActiveSupport::Concern\n\n  def check_pit\n    raise Pundit::NotAuthorizedError unless current_user.crew?\n  end\nend\n",
      // The decoy: the same filter names, bodies that never halt a caller.
      // A switched-off feature answers 401 yet checks no caller: its name says so.
      "app/controllers/switch_controller.rb":
        "class SwitchController < ActionController::Base\n  before_action :ensure_pits_enabled!\n\n  def index; end\n\n  private\n\n  def ensure_pits_enabled!\n    head :unauthorized unless Pit.on?\n  end\nend\n",
      "app/controllers/pits_controller.rb":
        "class PitsController < ApplicationController\n  before_action :check_pit\n  before_action :club_gate\n\n  def index; end\n\n  private\n\n  def check_pit\n    @pit = Pit.first\n  end\n\n  def club_gate\n    @gate = params[:gate]\n  end\nend\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const policies = (path: string) => summary.routeMap.find((r) => r.path === path)?.auth?.policies ?? [];

  it("guards the route of a filter that renders 401", () => {
    expect(policies("/cars")).toEqual(["check_garage"]);
  });
  it("guards through a filter a concern defines", () => {
    expect(policies("/garages")).toEqual(["check_pit"]);
  });
  it("guards through an ancestor's halting filter", () => {
    expect(policies("/clubs")).toEqual(["club_gate"]);
  });
  it("leaves a feature switch unguarded, whatever status it answers", () => {
    expect(policies("/switch")).toEqual([]);
  });
  it("leaves a namesake filter that only loads unguarded", () => {
    expect(policies("/pits")).toEqual([]);
  });
});
