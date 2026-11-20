/** The seven HTTP verbs a route table or client names, upper case (`GET`) and lower case (`get`), declared once. */
export const HTTP_VERBS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export const HTTP_VERBS_LOWER: ReadonlySet<string> = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
