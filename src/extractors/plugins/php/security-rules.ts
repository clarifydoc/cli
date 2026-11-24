import type { SecurityJudgement, SecurityRule } from "../../../types/language-plugin.js";

/**
 * `proc_open` handed an array (PHP 7.4+) starts the program with those
 * arguments and no shell: nothing in them is read as a command. An array
 * written in the call, or a variable whose nearest assignment before the call
 * is an array (`[…]`, `array(…)`, `array_merge([…], …)`), drops the finding.
 */
function judgeProcOpenArgv(source: string, at: number): SecurityJudgement | undefined {
  const call = /^proc_open\s*\(\s*/.exec(source.slice(at, at + 200));
  if (!call) return undefined;
  const arg = source.slice(at + call[0].length, at + call[0].length + 120);
  if (/^(?:\[|array\s*\()/i.test(arg)) return { drop: true };
  const name = /^\$(\w+)\s*[,)]/.exec(arg)?.[1];
  if (!name) return undefined;
  const before = source.slice(Math.max(0, at - 4000), at);
  const assigned = [...before.matchAll(new RegExp(String.raw`\$${name}\s*=(?!=)\s*([^;]{0,40})`, "g"))].at(-1)?.[1];
  return assigned !== undefined && /^(?:\[|array\s*\(|array_merge\s*\(\s*(?:\[|array\s*\())/i.test(assigned) ? { drop: true } : undefined;
}

/** PHP sinks and configuration that weaken an application (see the JVM rules for the stance). */
export const PHP_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "deserialization",
    severity: "high",
    pattern: /\bunserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b/,
    message: "unserialize() of request data can instantiate attacker-chosen objects. Use json_decode().",
    priority: 50,
  },
  {
    category: "deserialization",
    severity: "medium",
    // Request data is the rule above's, at high.
    pattern: /(?<![\w>:$]|function\s+)unserialize\s*\((?!\s*\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b)(?![^)]*allowed_classes)/,
    message: "unserialize() without allowed_classes instantiates any class the data names. Pass ['allowed_classes' => false] or use json_decode().",
    priority: 51,
    excludeTest: true,
  },
  {
    category: "command-injection",
    severity: "high",
    pattern: /(?<![\w>:$]|function\s+)(?:shell_exec|passthru|system|proc_open|popen|exec)\s*\([^)]*\$/,
    message: "An OS command is built from a variable. Escape every argument with escapeshellarg(), or avoid the shell.",
    priority: 52,
    excludeTest: true,
    judge: judgeProcOpenArgv,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    pattern: /(?<![\w>:$])(?:md5|sha1)\s*\([^)]*pass/i,
    message: "A password hashed with MD5/SHA-1. Use password_hash().",
    priority: 53,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-295",
    severity: "high",
    pattern: /CURLOPT_SSL_VERIFY(?:PEER|HOST)\s*(?:,|=>)\s*(?:false|0)\b/i,
    message: "cURL TLS certificate verification is turned off.",
    priority: 54,
    excludeTest: true,
  },
];
