import type { SecurityRule } from "../../../types/language-plugin.js";

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
