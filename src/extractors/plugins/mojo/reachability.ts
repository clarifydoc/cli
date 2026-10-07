import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Mojo dead-code model. `from shop.db import find` names a package path the
 * `-I` include path resolves, and what runs is what `mojo run`/`mojo build`
 * is handed — every file is kept alive and none anchors a program (never
 * reported dead).
 */
export const mojoReachability = conventionReachability({
  extensions: [".mojo", ".🔥"],
  names: { functions: true, types: true, stem: true },
  passiveFiles: [[/\.(?:mojo|🔥)$/u, "Mojo file (built or run by path)"]],
});
