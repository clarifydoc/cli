// Posts the CI comment (ci/run.sh's comment.md) on a GitLab merge request as
// one note, edited in place on every pipeline: the note is found by the marker
// on its first line. Needs CLARIFYDOC_GITLAB_TOKEN (a project or personal
// access token with `api` scope); without it, prints why and does nothing.
//
//   node ci/gitlab-note.mjs <comment.md>
import { readFileSync } from "node:fs";

const MARKER = "<!-- clarifydoc-ci -->";
const { CLARIFYDOC_GITLAB_TOKEN: token, CI_API_V4_URL: api, CI_PROJECT_ID: project, CI_MERGE_REQUEST_IID: mr } = process.env;
if (!token || !api || !project || !mr) {
  console.log("ClarifyDoc: no merge-request note (needs CLARIFYDOC_GITLAB_TOKEN in a merge-request pipeline)");
  process.exit(0);
}
const body = readFileSync(process.argv[2], "utf8");
const base = `${api}/projects/${encodeURIComponent(project)}/merge_requests/${mr}/notes`;
const headers = { "PRIVATE-TOKEN": token, "Content-Type": "application/json" };
try {
  let existing;
  for (let page = 1; page <= 20 && !existing; page++) {
    const res = await fetch(`${base}?per_page=100&page=${page}&sort=asc`, { headers });
    if (!res.ok) throw new Error(`listing notes: HTTP ${res.status}`);
    const notes = await res.json();
    existing = notes.find((n) => typeof n.body === "string" && n.body.startsWith(MARKER));
    if (notes.length < 100) break;
  }
  const res = existing
    ? await fetch(`${base}/${existing.id}`, { method: "PUT", headers, body: JSON.stringify({ body }) })
    : await fetch(base, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`${existing ? "editing" : "posting"} the note: HTTP ${res.status}`);
  console.log(`ClarifyDoc: merge-request note ${existing ? "updated" : "posted"}`);
} catch (err) {
  // A comment that could not be posted never fails the pipeline: the reports are the result.
  console.log(`ClarifyDoc: no merge-request note — ${err.message}`);
}
