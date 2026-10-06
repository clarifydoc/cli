import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Blazor dead-code model. A component is its file name, used as a tag
 * (`<Counter />`) — a name reference — and a component with `@page` is
 * routed by the framework. The code-behind partial class is C#, reached by
 * the same name.
 */
export const blazorReachability = conventionReachability({
  extensions: [".razor"],
  names: { types: true, stem: true },
  routesAreEntries: true,
  entryFiles: [[/(?:^|\/)(?:App|Routes|_Host|_Imports)\.razor$/, "Blazor application root"]],
});
