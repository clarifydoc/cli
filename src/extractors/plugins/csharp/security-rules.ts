import type { SecurityIssue } from "../../../types/analysis.js";
import type { SecurityRule } from "../../../types/language-plugin.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";

/** .NET sinks and configuration that weaken an application (see the JVM rules for the stance). */
export const CSHARP_SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "deserialization",
    severity: "high",
    pattern: /\bnew\s+(?:BinaryFormatter|NetDataContractSerializer|LosFormatter|SoapFormatter|ObjectStateFormatter)\s*\(|TypeNameHandling\s*=\s*TypeNameHandling\.(?:All|Auto|Objects|Arrays)\b/,
    message: "Polymorphic .NET deserialization (BinaryFormatter, TypeNameHandling ≠ None) can run attacker-chosen code. Use System.Text.Json or DataContractSerializer with known types.",
    priority: 50,
    excludeTest: true,
  },
  {
    category: "xxe",
    severity: "high",
    // `DtdProcessing.Parse` with `XmlResolver = null` beside it parses DTDs but
    // fetches no external entity.
    pattern: /(?<!XmlResolver\s*=\s*null\b[^;\n]*)DtdProcessing\s*=\s*DtdProcessing\.Parse\b(?![^;\n]*XmlResolver\s*=\s*null\b)|XmlResolver\s*=\s*new\s+XmlUrlResolver\b/,
    message: "The XML reader processes DTDs / resolves external entities (XXE). Leave DtdProcessing at Prohibit and XmlResolver null.",
    priority: 51,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    // A digest only where the line is about a credential: MD5/SHA-1 as a
    // checksum or cache key is not a weakness.
    pattern: new RegExp(String.raw`\b(?:MD5|SHA1)\.(?:Create\s*\(|HashData\s*\()(?=.*${CREDENTIAL_CONTEXT})|` + String.raw`\b(?:DES|TripleDES|RC2)\.Create\s*\(|\bnew\s+(?:DESCryptoServiceProvider|TripleDESCryptoServiceProvider|RC2CryptoServiceProvider)\b|CipherMode\.ECB\b`),
    message: "Broken or weak cryptography (MD5/SHA-1, DES/3DES/RC2, ECB). Use SHA-256+ and AES-GCM.",
    priority: 52,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-295",
    severity: "high",
    pattern: /(?:ServerCertificateCustomValidationCallback|ServerCertificateValidationCallback|RemoteCertificateValidationCallback)\s*\+?=\s*(?:\([^)]*\)|\w+)\s*=>\s*true\b|DangerousAcceptAnyServerCertificateValidator/,
    message: "TLS certificate validation is turned off (the callback always returns true).",
    priority: 53,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-352",
    severity: "medium",
    pattern: /\[\s*IgnoreAntiforgeryToken\b/,
    message: "Antiforgery validation is switched off for this action/controller (CSRF).",
    priority: 54,
    excludeTest: true,
  },
];

/**
 * CORS that lets any origin send credentials: `AllowAnyOrigin()` (or a
 * `SetIsOriginAllowed(_ => true)`) in a file that also `AllowCredentials()`.
 * Whole file, because the policy is built across a chain of calls.
 */
export function csharpSecurityPostScan(lines: string[], filePath: string): SecurityIssue[] {
  const text = lines.join("\n");
  if (!/\.AllowCredentials\s*\(/.test(text)) return [];
  const anyOrigin = /\.AllowAnyOrigin\s*\(|SetIsOriginAllowed\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*true/;
  const i = lines.findIndex((l) => anyOrigin.test(l) && !l.trimStart().startsWith("//"));
  if (i < 0) return [];
  return [{
    category: "insecure-config",
    cwe: "CWE-942",
    severity: "high",
    message: "CORS allows any origin together with credentials: any site can make authenticated requests on a user's behalf.",
    filePath,
    line: i + 1,
    snippet: lines[i]!.trim().slice(0, 100),
  }];
}
