import type { AgentBinding } from "./types.agents.js";

/** Refuses automatic binding appends when an include owns the bindings collection. */
export function assertAutomaticBindingsWriteAllowed(params: {
  bindingsIncludeOwned: boolean;
  ownershipPaths: readonly (readonly string[])[];
  sourceBindings: readonly AgentBinding[];
  nextBindings: readonly AgentBinding[];
}): void {
  if (
    !params.bindingsIncludeOwned ||
    !params.ownershipPaths.some((ownershipPath) => ownershipPath[0] === "bindings")
  ) {
    return;
  }
  const sourceBindingKeys = new Set(
    params.sourceBindings.map((binding) => JSON.stringify(binding)),
  );
  const requiredBindings = params.nextBindings.filter(
    (binding) => !sourceBindingKeys.has(JSON.stringify(binding)),
  );
  const required = requiredBindings.map((binding) => JSON.stringify(binding)).join(", ");
  throw Object.assign(
    new Error(
      `Automatic agent ownership materialization cannot append to $include-owned bindings. Add ${required || "the required channel-wide binding"} to the bindings include, then retry.`,
    ),
    { code: "CONFIG_WRITE_REJECTED" },
  );
}
