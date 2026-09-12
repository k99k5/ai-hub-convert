import { loadConfig, type Environment } from "../../src/config.js";

// Keep the original Responses routing/fallback regression suite explicit.
// Forced Chat routing tests use loadConfig directly to exercise the new default.
export function loadResponsesConfig(environment: Environment) {
  return loadConfig({ UPSTREAM_PROTOCOL: "responses", ...environment });
}
