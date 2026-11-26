# JSP plugin

Reads `.jsp`/`.jspx`/`.jspf`/`.tag` through the regex path (`importTarget: false`).

- The framework rule `jsp` lives here (cross-cutting rules live with the plugin that owns the file format; [frameworks.ts](frameworks.ts)).
- A base-URL prefix before a link's path — JSP `contextPath` — is dropped by core's `BASE_URL_PREFIX` when the link is matched to a route.
