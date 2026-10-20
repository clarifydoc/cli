/**
 * HTTP status names as frameworks spell them, to their codes: Go's
 * `http.StatusCreated`, Rails' `:created`, Symfony's `Response::HTTP_CREATED`,
 * Laravel's `Response::HTTP_CREATED` / `201`.
 */
const BY_NAME: Record<string, number> = {
  continue: 100, ok: 200, created: 201, accepted: 202, nonauthoritativeinfo: 203, nonauthoritativeinformation: 203, nocontent: 204, resetcontent: 205, partialcontent: 206,
  movedpermanently: 301, found: 302, seeother: 303, notmodified: 304, temporaryredirect: 307, permanentredirect: 308,
  badrequest: 400, unauthorized: 401, paymentrequired: 402, forbidden: 403, notfound: 404, methodnotallowed: 405, notacceptable: 406,
  conflict: 409, gone: 410, preconditionfailed: 412, requestentitytoolarge: 413, payloadtoolarge: 413, unsupportedmediatype: 415,
  unprocessableentity: 422, unprocessablecontent: 422, locked: 423, toomanyrequests: 429,
  internalservererror: 500, notimplemented: 501, badgateway: 502, serviceunavailable: 503, gatewaytimeout: 504,
};

/** `201`, `http.StatusCreated`, `:created`, `Response::HTTP_CREATED`, `HttpStatus.CREATED` → 201; null when unknown. */
export function statusCode(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.trim();
  if (/^\d{3}$/.test(t)) return Number(t);
  const name = t.replace(/^.*(?:\.|::)/, "").replace(/^:/, "").replace(/^(?:Status|HTTP_)/, "").replace(/[_\s]/g, "").toLowerCase();
  return BY_NAME[name] ?? null;
}
