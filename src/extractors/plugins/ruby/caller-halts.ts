/**
 * Whether a Rails filter body halts a caller it could not identify or permit. A halting statement counts
 * only when the condition governing it tests WHO the caller is — bare presence of the caller, or a
 * permission/role/ownership predicate on it — and the halt happens when that test fails. A condition on
 * a parameter, a feature switch, another record's state, or an account-state predicate on a caller
 * already identified (`active?`, `confirmed?`) never qualifies; neither does an unconditional halt.
 * When in doubt: not a guard.
 */

const USER = String.raw`@?current_(?:user|account|member|player|admin|staff|api_user|principal)`;
/** Words of a state predicate on an identified caller: the caller is known, so it checks nobody. */
const STATE_WORD =
  /^(?:active|inactive|confirmed|unconfirmed|suspended|locked|onboarded|onboarding|subscribed|banned|blocked|verified|deleted|disabled|enabled|activated|expired|trial|trialing|premium|paid|archived|approved|complete|completed|new|persisted|valid|accepted|pending|registered|invited|eligible|email|phone|terms|agreed|accepted)$/;
const CREDENTIAL_KEY = /(?:user|account|member|player|admin|staff|auth|token|login|uid|driver)/i;

type Verdict = "ok" | "absent" | null;

function stripParens(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")") && balancedOuter(t)) t = t.slice(1, -1).trim();
  return t;
}

function balancedOuter(t: string): boolean {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")" && --depth === 0 && i < t.length - 1) return false;
  }
  return true;
}

/** Splits at top-level `||`, `&&`, `and`, `or`. */
function splitOperands(cond: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cond.length; i++) {
    const c = cond[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      const rest = cond.slice(i);
      const m = /^(?:\|\||&&|(?<=\s)(?:and|or)(?=\s))/.exec(rest);
      if (m) {
        out.push(cond.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  out.push(cond.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** What an atom's truth says: the caller is identified/permitted (`ok`), or absent/refused (`absent`); null when it says neither. */
function coreVerdict(core: string): Verdict {
  const t = core.trim();
  let m: RegExpExecArray | null;
  const user = new RegExp(`^${USER}$`);
  if (user.test(t)) return "ok";
  if (new RegExp(`^${USER}(?:&?\\.)present\\?$`).test(t)) return "ok";
  if (new RegExp(`^${USER}(?:&?\\.)(?:nil|blank)\\?$`).test(t)) return "absent";
  if (/^(?:\w+_)?(?:logged_in|signed_in|authenticated|authorized|user_signed_in|admin_signed_in)\?(?:\(\))?$/.test(t)) return "ok";
  if (/^(?:current_ability\.|ability\.)?(?:can|authorized|allowed|has_permission|permitted)\?\(.*\)$/.test(t)) return "ok";
  if (/^(?:current_ability\.|ability\.)?cannot\?\(.*\)$/.test(t)) return "absent";
  if (/^policy\(.*\)\.\w+\?$/.test(t)) return "ok";
  if (/^authenticate(?:_or_request)?_with_http_(?:token|basic)\b.*$/.test(t)) return "ok";
  if (/^session\[[^\]]+\]$/.test(t)) return CREDENTIAL_KEY.test(t) ? "ok" : null;
  if ((m = /^(session\[[^\]]+\])(?:&?\.)(present|nil|blank)\?$/.exec(t))) {
    if (!CREDENTIAL_KEY.test(m[1]!)) return null;
    return m[2] === "present" ? "ok" : "absent";
  }
  if (/^request\.headers\[[^\]]*(?:auth|token|key)[^\]]*\]$/i.test(t) || /^request\.authorization$/.test(t)) return "ok";
  if (/^params\[:(?:api_key|token|access_token|auth_token)\]$/.test(t)) return "ok";
  if ((m = /^(request\.headers\[[^\]]*(?:auth|token|key)[^\]]*\]|request\.authorization)(?:&?\.)(present|nil|blank)\?$/i.exec(t)))
    return m[2] === "present" ? "ok" : "absent";
  // A predicate or role read on the caller.
  if ((m = new RegExp(`^${USER}&?\\.(\\w+)\\?(?:\\(.*\\))?$`).exec(t))) {
    const words = m[1]!.split("_");
    return words.some((w) => STATE_WORD.test(w)) ? null : "ok";
  }
  if (new RegExp(`^${USER}&?\\.(?:admin|superadmin|super_admin|staff|has_role\\??|has_permission\\??|can|roles?\\w*)(?:\\(.*\\))?$`).test(t)) return "ok";
  if (new RegExp(`^${USER}&?\\.roles?\\w*\\.(?:include\\?|any\\?)\\(.*\\)$`).test(t)) return "ok";
  if (new RegExp(`^.*\\.include\\?\\(\\s*${USER}&?\\.role\\w*\\s*\\)$`).test(t)) return "ok";
  if ((m = new RegExp(`^${USER}&?\\.roles?\\w*\\s*(==|!=)\\s*.+$`).exec(t))) return m[1] === "==" ? "ok" : "absent";
  if (new RegExp(`^\\S+\\.owned_by\\?\\(\\s*${USER}\\s*\\)$`).test(t)) return "ok";
  if (new RegExp(`^${USER}&?\\.(?:owns|owner_of|manages|member_of)\\?\\(.*\\)$`).test(t)) return "ok";
  // Ownership: <record>.owner == current_user (or its id), either side.
  if ((m = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(t))) {
    const isUser = (s: string) => new RegExp(`^${USER}(?:\\.id)?$`).test(s.trim());
    const isOwner = (s: string) => /\b\w*(?:owner|user|creator|author|manager|coach|account|member)\w*\b/.test(s) && !isUser(s) && !/[()]/.test(s.replace(/\.\w+\?/g, ""));
    if ((isUser(m[1]!) && isOwner(m[3]!)) || (isUser(m[3]!) && isOwner(m[1]!))) return m[2] === "==" ? "ok" : "absent";
  }
  return null;
}

/** True when truth of the atom means the caller is ok; false when it means absent; null when unrecognized. */
function truthMeansOk(atom: string): boolean | null {
  let t = stripParens(atom);
  let flip = false;
  for (;;) {
    const n = /^(?:!|not\s+)\s*(.*)$/.exec(t);
    if (!n) break;
    flip = !flip;
    t = stripParens(n[1]!);
  }
  const v = coreVerdict(t);
  if (v === null) return null;
  return (v === "ok") !== flip;
}

/** Whether `if|unless <cond>` is true exactly when the caller is absent or refused (`halt: true`), or exactly when ok. */
function failsCallerTest(kind: "if" | "unless", cond: string, wantHaltOnFail = true): boolean {
  const operands = splitOperands(stripParens(cond));
  if (operands.length === 0) return false;
  for (const op of operands) {
    const ok = truthMeansOk(op);
    if (ok === null) return false;
    // The branch runs when the condition is true (`if`) or false (`unless`): it must be when the caller fails.
    const branchOnOk = kind === "unless" ? !ok : ok;
    if (wantHaltOnFail ? branchOnOk : !branchOnOk) return false;
  }
  return true;
}

const HALT_STATUS = String.raw`(?::unauthorized|:forbidden|401|403)\b`;
const HALT = new RegExp(
  [
    String.raw`\bhead\s*\(?\s*${HALT_STATUS}`,
    String.raw`\brender\b[^\n]*(?:\bstatus:|:status\s*=>)\s*${HALT_STATUS}`,
    String.raw`\braise\s+(?:\w+::)*(?:NotAuthorized\w*|Unauthorized\w*|AccessDenied|Forbidden\w*|NotAuthenticated\w*)\b`,
    String.raw`(?<![\w.@:])(?:redirect_to|redirect_back)\b`,
  ].join("|"),
);

interface Block {
  kind: "if" | "unless" | "other";
  cond: string;
}

/** The lines are the method body, comments stripped, trimmed and non-blank. */
export function callerHalts(lines: string[]): boolean {
  const stack: Block[] = [];
  let seenReturnGuard = false;
  let guardsBefore = true; // every depth-0 line so far is a `return` that leaves only a refused caller
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if (HALT.test(line)) {
      const mod = /\s(if|unless)\s+(.+)$/.exec(line);
      if (mod) {
        if (stack.length === 0 && failsCallerTest(mod[1] as "if" | "unless", mod[2]!)) return true;
      } else if (stack.length === 1 && stack[0]!.kind !== "other") {
        if (failsCallerTest(stack[0]!.kind, stack[0]!.cond)) return true;
      } else if (stack.length === 0 && guardsBefore && seenReturnGuard) {
        return true;
      }
      guardsBefore = false;
      continue;
    }
    if ((m = /^(if|unless)\s+(.*?)(?:\s+then)?$/.exec(line))) {
      stack.push({ kind: m[1] as "if" | "unless", cond: m[2]! });
      guardsBefore = false;
    } else if (/^elsif\b/.test(line)) {
      if (stack.length) stack[stack.length - 1]!.kind = "other";
    } else if (/^else\b/.test(line)) {
      const top = stack[stack.length - 1];
      if (top && top.kind !== "other") top.kind = top.kind === "if" ? "unless" : "if";
    } else if (/^(?:case|while|until|for|begin)\b/.test(line) || /\bdo(?:\s*\|[^|]*\|)?$/.test(line)) {
      stack.push({ kind: "other", cond: "" });
      guardsBefore = false;
    } else if (/^end\b/.test(line)) {
      stack.pop();
    } else if (stack.length === 0 && (m = /^return(?:\s+true)?\s+(if|unless)\s+(.+)$/.exec(line))) {
      // `return if current_user&.admin?` leaves the filter for an ok caller; what follows is for the rest.
      if (failsCallerTest(m[1] as "if" | "unless", m[2]!, false)) seenReturnGuard = true;
      else guardsBefore = false;
    } else if (stack.length === 0) {
      guardsBefore = false;
    }
  }
  return false;
}
