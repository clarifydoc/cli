/**
 * Words that put a digest on a credential's path — a password hashed, a
 * secret derived, a token or signature computed. MD5/SHA-1 elsewhere (an
 * ETag, a cache key, Git's object ids, a Gravatar hash) is a checksum, not a
 * weakness. Each word starts at a word or camelCase boundary, so `bypass`,
 * `design`, `assign` and `author` do not count. As a regex source, for a
 * `(?=.*…)` lookahead on the line.
 */
export const CREDENTIAL_CONTEXT =
  "(?:(?<![a-z])(?:[Pp]ass(?:word|wd|phrase)?|[Pp]wd|[Ss]ecret|[Tt]oken|[Ss]ign(?:ature|ed|ing)?|[Ss]alt|[Cc]redential|[Aa]uth(?!or))|PASSWORD|SECRET|TOKEN)";
