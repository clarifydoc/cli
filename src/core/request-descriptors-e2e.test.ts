import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A frontend's request named somewhere other than the call: a helper handing
 * back a request descriptor (`{ url, params }`) whose `url` the call reads, an
 * endpoint table indexed by the name a call passes, and a URL built by one
 * method and handed to another that fetches it.
 */
const FILES: Record<string, string> = {
  "server/app.js": `const express = require("express");
const app = express();
app.put("/api/v1/profile", (req, res) => res.json({}));
app.post("/api/v1/profile/availability", (req, res) => res.json({}));
app.get("/auth/validate_token", (req, res) => res.json({}));
app.post("/api/v1/clubs/:clubId/callbacks/pages", (req, res) => res.json({}));
app.patch("/api/v1/widget/messages/:id", (req, res) => res.json({}));
app.put("/public/api/v1/surveys/:uuid", (req, res) => res.json({}));
app.get("/api/organizers/clubs/empty", (req, res) => res.json({}));
app.post("/api/v1/widget/integrations/meeting", (req, res) => res.json({}));
app.get("/api/download/chapter", (req, res) => res.json({}));
app.get("/api/download/volume", (req, res) => res.json({}));
module.exports = app;
`,
  "web/api/endPoints.js": `const endPoints = {
  profileUpdate: {
    url: '/api/v1/profile',
  },
  availabilityUpdate: {
    url: '/api/v1/profile/availability',
  },
  validityCheck: {
    url: '/auth/validate_token',
  },
  fetchPages: {
    url(clubId) {
      return \`api/v1/clubs/\${clubId}/callbacks/pages\`;
    },
    params: { token: '' },
  },
};

export default page => {
  return endPoints[page];
};
`,
  "web/api/auth.js": `/* global axios */
import endPoints from './endPoints';

export default {
  validityCheck() {
    const urlData = endPoints('validityCheck');
    return axios.get(urlData.url);
  },
  updateSettings({ settings }) {
    return axios.put(endPoints('profileUpdate').url, { profile: { settings } });
  },
  updateAvailability(data) {
    return axios.post(endPoints('availabilityUpdate').url, { profile: data });
  },
  fetchPages(token, clubId) {
    const urlData = endPoints('fetchPages');
    urlData.params.token = token;
    return axios.post(urlData.url(clubId), urlData.params);
  },
};
`,
  "web/widget/endPoints.js": `const updateMessage = id => ({
  url: \`/api/v1/widget/messages/\${id}\${window.location.search}\`,
});

const updateSurvey = ({ uuid, data }) => ({
  url: \`/public/api/v1/surveys/\${uuid}\`,
  data,
});

export default {
  updateMessage,
  updateSurvey,
};
`,
  "web/widget/message.js": `import axios from 'axios';
import widgetEndPoints from './endPoints';

export default {
  update: ({ messageId, email }) => {
    const urlData = widgetEndPoints.updateMessage(messageId);
    return axios.patch(urlData.url, { contact: { email } });
  },
  rate: async ({ uuid, data }) => {
    const urlData = widgetEndPoints.updateSurvey({ data, uuid });
    await axios.put(urlData.url, { ...urlData.data });
  },
  join: (messageId) => {
    const search = buildSearch(window.location.search);
    const urlData = {
      url: \`/api/v1/widget/integrations/meeting\${search}\`,
    };
    return axios.post(urlData.url, { message_id: messageId });
  },
};
`,
  "web/api/config.js": `const PREFIX = "/api";

export const config = {
  PREFIX,
};
`,
  "web/api/clubs.js": `/* global axios */
import { config } from './config';

const prefix = config.PREFIX + "/organizers";
const routes = {
  clubsEmpty: \`\${prefix}/clubs/empty\`,
};

export default {
  getEmpty() {
    return axios.get(routes.clubsEmpty);
  },
};
`,
  "web/api/guesses.js": `/* global axios */
import endPoints from './endPoints';
import widgetEndPoints from '../widget/endPoints';

export default {
  byName(page) {
    return axios.get(endPoints(page).url);
  },
  sendTo(id) {
    return axios.post(widgetEndPoints.updateMessage(id).params);
  },
};
`,
  "web/services/download.service.ts": `export class DownloadService {
  private baseUrl = '/api/';

  queueChapter(chapterId: number) {
    const url = \`\${this.baseUrl}download/chapter\` +
                \`?chapterId=\${chapterId}\` +
                \`&_t=\${Date.now()}\`;
    this.fetchDownload(chapterId, url);
  }

  queueVolume(volumeId: number) {
    this.fetchDownload(volumeId, \`\${this.baseUrl}download/volume?volumeId=\${volumeId}\`);
  }

  private async fetchDownload(id: number, url: string) {
    const response = await fetch(url);
    return response.blob();
  }
}
`,
};

describe("request descriptors and URLs handed on (e2e)", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-request-descriptors-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const linksFrom = (file: string) =>
    (summary.apiRouteLinks ?? []).filter((l) => l.source === file).map((l) => `${l.sourceLine} ${l.method} ${l.routePath}`).sort();

  it("reads `.url` of an endpoint table entry the call names, directly or through a local", () => {
    expect(linksFrom("web/api/auth.js")).toEqual([
      "10 PUT /api/v1/profile",
      "13 POST /api/v1/profile/availability",
      "18 POST /api/v1/clubs/:clubId/callbacks/pages",
      "7 GET /auth/validate_token",
    ]);
  });

  it("reads `.url` of the object literal a helper returns, or a local holds", () => {
    expect(linksFrom("web/widget/message.js")).toEqual([
      "11 PUT /public/api/v1/surveys/:uuid",
      "18 POST /api/v1/widget/integrations/meeting",
      "7 PATCH /api/v1/widget/messages/:id",
    ]);
  });

  it("leaves a module's URL table to the module values, which follow its names across modules", () => {
    expect(summary.apiCalls.filter((c) => c.filePath === "web/api/clubs.js").map((c) => c.target)).toEqual(["/api/organizers/clubs/empty"]);
    expect(linksFrom("web/api/clubs.js")).toEqual(["11 GET /api/organizers/clubs/empty"]);
  });

  it("reads nothing off an entry named at run time, or a key that is not the descriptor's URL", () => {
    expect(linksFrom("web/api/guesses.js")).toEqual([]);
  });

  it("follows a URL a method builds into the method that fetches it", () => {
    expect(linksFrom("web/services/download.service.ts")).toEqual(["12 GET /api/download/volume", "8 GET /api/download/chapter"]);
  });
});
