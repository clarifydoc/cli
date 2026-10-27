/**
 * Whether a callable's NAME says it checks who is calling — the rule a route
 * guard is told from a loader by, where a framework runs a project function
 * before the handler (a FastAPI dependency, a Rails `before_action`):
 * `verify_token`, `get_admin_user`, `authorize_request!`, `getCurrentUser` are
 * checks; `get_profile_by_username`, `ensure_feature_enabled`, `get_db` are not.
 * Judged word by word: an auth word (token, permission, scope, admin, verify,
 * login, …), or a user word qualified as the caller (`current_user`). An
 * optional caller (`try_get_current_user`) lets everyone in and is no check,
 * nor is a switch (`ensure_sso_feature_enabled`).
 */

/** Words that say the callable checks the caller. */
const AUTH_WORD = /^(?:auth|auths|authn|authz|authori[sz]\w*|authenticat\w*|token|tokens|jwt|oauth2?|bearer|security|secure|scopes?|permissions?|perms?|login|logged|verify|verified|requires?|required|admin|superuser|credentials?|apikey|guard|guarded|protected|signed|signature|access|mfa|otp|totp|sso)$/;
/** A user-ish word guards only when the name says it is the caller (`get_current_user`), not a record looked up (`get_profile_by_username`). */
const CALLER_WORD = /^(?:current|active|logged|authenticated|authorized|request|requesting|session)$/;
const PRINCIPAL_WORD = /^(?:user|users|account|principal|member|identity|caller)$/;
/** An optional caller (`try_get_current_user`, `authorizer(required=False)`) lets everyone in: not a guard. */
const OPTIONAL_WORD = /^(?:try|optional|maybe|soft)$/;
/** A switch, not a caller: `ensure_sso_feature_enabled`, `check_mfa_available` gate on configuration. */
const SWITCH_WORD = /^(?:feature|features|enabled|disabled|available|configured|supported|installed)$/;

/** `get_current_user_authorizer` → [get, current, user, authorizer]; `deps.verifyToken` → [verify, token]; `authorize!` → [authorize]. */
export function nameWords(name: string): string[] {
  const leaf = name.replace(/^.*\./, "").replace(/[?!]+$/, "");
  return leaf.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/_+/).filter(Boolean);
}

/** The rule above, on a callable's name as written (a dotted path's last segment). */
export function namesCallerCheck(name: string): boolean {
  const words = nameWords(name);
  if (words.some((w) => OPTIONAL_WORD.test(w) || SWITCH_WORD.test(w))) return false;
  if (words.some((w) => AUTH_WORD.test(w))) return true;
  return words.some((w) => PRINCIPAL_WORD.test(w)) && words.some((w) => CALLER_WORD.test(w));
}
