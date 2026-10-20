import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { RubyEntityExtractor } from "./entities.js";

describe("Ruby chain rows through memoizers and instance variables", () => {
  it("types `@agent.update!` by what the filter assigned, through the memoizer it called", () => {
    const user = extractWithRegex(`class User < ApplicationRecord
  has_many :account_users
end`, "app/models/user.rb", "ruby");
    const account = extractWithRegex(`class Account < ApplicationRecord
  has_many :users
end`, "app/models/account.rb", "ruby");
    const ctl = extractWithRegex(`class Api::AgentsController < Api::BaseController
  before_action :fetch_agent, except: [:index]

  def update
    @agent.update!(agent_params)
  end

  private

  def fetch_agent
    @agent = agents.find(params[:id])
  end

  def agents
    @agents ||= Current.account.users.order_by_full_name.includes(:avatar)
  end
end`, "app/controllers/api/agents_controller.rb", "ruby");
    const analyses = [user, account, ctl];
    new RubyEntityExtractor().reconcileProject(analyses);
    const rows = ctl.dataSources.filter((d) => d.kind === "database").map((d) => `${d.line} ${d.name} ${d.entity ?? "-"}`).sort();
    // `agents.find` is a read on a bare variable — no row per file (an Array reads the same).
    expect(rows).toEqual([
      "15 Current.account.users.order_by_full_name.includes User",
      "5 @agent.update! User",
    ]);
  });
});

describe("Ruby service objects are not models", () => {
  it("drops `UserService.create` when the project declares UserService and it is not a model, and keeps real and undeclared models", () => {
    const user = extractWithRegex(`class User < ApplicationRecord
end`, "app/models/user.rb", "ruby");
    const service = extractWithRegex(`class UserService
  def self.create(attrs)
    User.create(attrs)
  end
end`, "app/services/user_service.rb", "ruby");
    const ctl = extractWithRegex(`class UsersController < ApplicationController
  def create
    UserService.create(params)
    User.find(params[:id])
    Billing::Invoice.where(paid: true)
  end
end`, "app/controllers/users_controller.rb", "ruby");
    new RubyEntityExtractor().reconcileProject([user, service, ctl]);
    const rows = (a: typeof ctl) => a.dataSources.filter((d) => d.kind === "database").map((d) => `${d.name} ${d.entity ?? "-"}`);
    expect(rows(ctl)).toEqual(["User.find User", "Billing::Invoice.where Invoice"]);
    expect(rows(service)).toEqual(["User.create User"]);
  });
});
