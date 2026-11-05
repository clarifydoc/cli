import type { PropertyInfo } from "../../../types/analysis.js";

/**
 * `KeepCommand = new RelayCommand(Keep)` (in the constructor, an initializer or an expression-bodied
 * property), with `DelegateCommand`, `AsyncRelayCommand`, `ReactiveCommand`… and the lambda forms
 * `new RelayCommand(() => Keep())` / `async () => await Keep()`: the command property runs `Keep`.
 * Only a command built over one method of the class is recorded; one built over a lambda body
 * with other statements, or assigned twice to different methods, names nothing.
 */
const COMMAND_BUILD_RE =
  /\b(\w+)\s*(?:=>|=)\s*new\s+[\w.]*Command\w*(?:<[^>()]*>)?\s*\(\s*(?:(?:async\s+)?\(\s*\w*\s*\)\s*=>\s*(?:await\s+)?|(?:async\s+)?\w+\s*=>\s*(?:await\s+)?)?(?:this\.)?([A-Za-z_]\w*)\s*(?=[,)(])/g;

export function attachCommandHandlers(classText: string, properties: PropertyInfo[]): void {
  if (!classText.includes("Command")) return;
  const found = new Map<string, string | null>();
  for (const m of classText.matchAll(COMMAND_BUILD_RE)) {
    const prior = found.get(m[1]!);
    found.set(m[1]!, prior === undefined || prior === m[2]! ? m[2]! : null);
  }
  for (const p of properties) {
    const handler = found.get(p.name);
    if (handler) p.commandHandler = handler;
  }
}
