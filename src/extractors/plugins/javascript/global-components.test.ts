import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractSubComponents } from "./sub-components.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ImportInfo, ProjectAnalysis } from "../../../types/analysis.js";

const defaultImport = (specifier: string, source: string, line: number): ImportInfo => ({
  source,
  specifiers: [specifier],
  isDefault: true,
  isNamespace: false,
  isType: false,
  line,
});

async function registrations(src: string, imports: ImportInfo[]): Promise<string[]> {
  const subs = extractSubComponents(await parseSource(src, "javascript" as never, "components.js"), src, "javascript" as never, imports);
  return subs.map((s) => `${s.name} ${s.importSource} ${s.global ?? false}`);
}

describe("Vue components registered app-wide", () => {
  it("are global entries naming each registered component's import source", async () => {
    const src = `import PClubCard from "component/club/card.vue";
import PFixtureList from "component/fixture/list.vue";

export function install(app) {
  app.component("PClubCard", PClubCard);
  app.component("p-fixture-list", PFixtureList);
  app.component("PUnknown", somethingElse);
}
`;
    expect(await registrations(src, [defaultImport("PClubCard", "src/component/club/card.vue", 1), defaultImport("PFixtureList", "src/component/fixture/list.vue", 2)])).toEqual([
      "PClubCard src/component/club/card.vue true",
      "p-fixture-list src/component/fixture/list.vue true",
    ]);
  });

  const kitImports = [defaultImport("DeleteModal", "src/kit/DeleteModal.vue", 1), defaultImport("KitButton", "src/kit/KitButton.vue", 2)];
  const head = `import DeleteModal from "./kit/DeleteModal.vue";\nimport KitButton from "./kit/KitButton.vue";\n`;

  it("reads a loop over the object's own keys inside its install method, under the literal prefix", async () => {
    const src = `${head}
const ClubKit = {
  DeleteModal,
  Button: KitButton,
  install(Vue) {
    const keys = Object.keys(this);
    keys.pop();
    let i = keys.length;
    while (i--) {
      Vue.component(\`club\${keys[i]}\`, this[keys[i]]);
    }
  },
};
export default ClubKit;
`;
    expect(await registrations(src, kitImports)).toEqual(["clubDeleteModal src/kit/DeleteModal.vue true", "clubButton src/kit/KitButton.vue true"]);
  });

  it("reads Object.keys(…).forEach, for…in over this, and Object.entries destructuring", async () => {
    const keysLoop = `${head}
const components = { DeleteModal, KitButton };
export default { install(Vue) { Object.keys(components).forEach((key) => Vue.component(\`club\${key}\`, components[key])); } };
`;
    const forIn = `${head}
export default { DeleteModal, KitButton, install(Vue) { for (const key in this) Vue.component(\`club\${key}\`, this[key]); } };
`;
    const entries = `${head}
const kit = { DeleteModal, KitButton };
export function install(app) {
  Object.entries(kit).forEach(([name, component]) => app.component(\`Club\${name}\`, component));
}
export function installAgain(app) {
  for (const [name, component] of Object.entries(kit)) app.component(name, component);
}
`;
    expect(await registrations(keysLoop, kitImports)).toEqual(["clubDeleteModal src/kit/DeleteModal.vue true", "clubKitButton src/kit/KitButton.vue true"]);
    expect(await registrations(forIn, kitImports)).toEqual(["clubDeleteModal src/kit/DeleteModal.vue true", "clubKitButton src/kit/KitButton.vue true"]);
    expect(await registrations(entries, kitImports)).toEqual([
      "ClubDeleteModal src/kit/DeleteModal.vue true",
      "ClubKitButton src/kit/KitButton.vue true",
      "DeleteModal src/kit/DeleteModal.vue true",
      "KitButton src/kit/KitButton.vue true",
    ]);
  });

  it("refuses a prefix that is not literal, a name the key does not end, and a value read by another key", async () => {
    const src = `${head}
const components = { DeleteModal, KitButton };
const prefix = process.env.KIT_PREFIX;
export default {
  install(Vue) {
    Object.keys(components).forEach((key) => {
      Vue.component(\`\${prefix}\${key}\`, components[key]);
      Vue.component(\`\${key}Club\`, components[key]);
      Vue.component(\`club\${key}\`, components[other]);
      Vue.component(\`club\${key}\`, someComponent);
    });
  },
};
`;
    expect(await registrations(src, kitImports)).toEqual([]);
  });
});

/**
 * A shared kit registers its components in a loop under a prefix, and a page binds functions and listeners on the
 * prefixed kebab tag: the child's clicks reach the page's handlers. A second kit's prefix is read from the
 * environment, so its tag stays unknown. Labels written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "club-admin", dependencies: { vue: "^2.7.0", axios: "^1.6.0" } }),
  "src/components/modal/DeleteModal.vue": `<template>
  <div class="modal">
    <button class="cancel" @click="onClose">Cancel</button>
    <button class="confirm" @click="onConfirm">Delete</button>
  </div>
</template>
<script>
export default {
  props: { onClose: { type: Function, default: () => {} }, onConfirm: { type: Function, default: () => {} } },
};
</script>
`,
  "src/components/KitButton.vue": `<template>
  <button class="kit" @click="$emit('press')"><slot /></button>
</template>
<script>
export default { name: 'KitButton' };
</script>
`,
  "src/components/index.js": `import DeleteModal from './modal/DeleteModal.vue';
import KitButton from './KitButton.vue';

const ClubKit = {
  DeleteModal,
  KitButton,
  install(Vue) {
    const keys = Object.keys(this);
    keys.pop();
    let i = keys.length;
    while (i--) {
      Vue.component(\`club\${keys[i]}\`, this[keys[i]]);
    }
  },
};

export default ClubKit;
`,
  "src/api/players.js": `import axios from 'axios';
export function deletePlayer(id) {
  return axios.delete(\`/api/v2/players/\${id}\`);
}
export function renamePlayer(id) {
  return axios.patch(\`/api/v2/players/\${id}\`);
}
`,
  "src/pages/PlayerPage.vue": `<template>
  <div>
    <club-kit-button @press="rename">Rename</club-kit-button>
    <ClubDeleteModal :on-confirm="removePlayer" :on-close="hide" />
  </div>
</template>
<script>
import { deletePlayer, renamePlayer } from '../api/players';
export default {
  data() { return { shown: false, id: 1 }; },
  methods: {
    removePlayer() { deletePlayer(this.id); },
    rename() { renamePlayer(this.id); },
    hide() { this.shown = false; },
  },
};
</script>
`,
  "src/other/modal/TrophyModal.vue": `<template>
  <div><button class="ok" @click="onConfirm">OK</button></div>
</template>
<script>
export default { props: { onConfirm: Function } };
</script>
`,
  "src/other/index.js": `import TrophyModal from './modal/TrophyModal.vue';

const components = { TrophyModal };
const prefix = process.env.KIT_PREFIX;

export default {
  install(Vue) {
    Object.keys(components).forEach((key) => {
      Vue.component(\`\${prefix}\${key}\`, components[key]);
    });
  },
};
`,
  "src/pages/TrophyPage.vue": `<template>
  <div><trophy-modal :on-confirm="awardTrophy" /></div>
</template>
<script>
import axios from 'axios';
export default {
  methods: { awardTrophy() { axios.post('/api/v2/trophies'); } },
};
</script>
`,
  "src/main.js": `import Vue from 'vue';
import ClubKit from './components';
import OtherKit from './other';
Vue.use(ClubKit);
Vue.use(OtherKit);
`,
};

describe("Vue components registered by an install loop", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-install-loop-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksInto = (file: string) =>
    summary.symbolLinks
      .filter((l) => l.targetFile === file && l.sourceFile !== file && l.relation === "dispatch")
      .map((l) => `${l.sourceFile}:${l.sourceSymbol} -${l.callName}-> ${l.targetSymbol}`)
      .sort();

  it("joins the prefixed tag's function props and emits to the page's handlers", () => {
    expect(linksInto("src/pages/PlayerPage.vue")).toEqual([
      "src/components/KitButton.vue:<template> -emit:press-> rename",
      "src/components/modal/DeleteModal.vue:<setup> -onClose-> hide",
      "src/components/modal/DeleteModal.vue:<setup> -onConfirm-> removePlayer",
    ]);
  });

  it("leaves a tag registered under a prefix that is not literal unjoined", () => {
    expect(linksInto("src/pages/TrophyPage.vue")).toEqual([]);
  });
});
