import { describe, it, expect } from "vitest";
import { namesCallerCheck } from "./guard-words.js";

describe("namesCallerCheck", () => {
  it("takes a name for a check of the caller only when its words say so", () => {
    const checks = ["get_current_user", "get_admin_user", "verify_token", "authenticate_steward!", "check_authorization", "getCurrentUser", "deps.verifyApiKey", "check_account_mfa_enforcement"];
    const loaders = ["get_db", "get_profile_by_username_from_path", "ensure_league_feature_enabled", "check_sso_enabled", "try_get_current_user", "fetch_fixture", "club"];
    expect(checks.filter((n) => !namesCallerCheck(n))).toEqual([]);
    expect(loaders.filter((n) => namesCallerCheck(n))).toEqual([]);
  });
});
