import type { ProjectMarkerContext } from "../../../types/language-plugin.js";

/** An sbt meta-build (`project/build.sbt` beside `project/plugins.sbt`) belongs to the build above it, not a project of its own. */
export function notSbtMetaBuild(file: ProjectMarkerContext): boolean {
  return file.dir.split("/").pop() !== "project";
}
