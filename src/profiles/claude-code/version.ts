import { compare, valid } from "semver";

const ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";
const ATTRIBUTION_VERSION = /(?:^|;\s*)cc_version=(\d+\.\d+\.\d+)(?:\.[0-9a-fA-F]{3})?;/;
const USER_AGENT_VERSION = /^claude-cli\/(\d+\.\d+\.\d+)(?=[ (]|$)/;
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ClaudeCodeVersionInput {
  system?: string | readonly SystemBlock[];
  userAgent?: string;
}

interface SystemBlock {
  type?: string;
  text?: string;
}

export type ClaudeCodeVersionResult =
  | {
      source: "system" | "user-agent";
      version: string;
      userAgentMismatch: boolean;
    }
  | {
      source: "none";
      userAgentMismatch: false;
    };

export interface VersionRangeInput {
  min?: string;
  max?: string;
}

export interface VersionRange {
  min?: string;
  max?: string;
}

export class ClaudeCodeVersionRangeError extends Error {
  readonly direction: "below" | "above";

  constructor(direction: "below" | "above") {
    super(`Claude Code version is ${direction} the supported range`);
    this.name = "ClaudeCodeVersionRangeError";
    this.direction = direction;
  }
}

export function extractClaudeCodeVersion(input: ClaudeCodeVersionInput): ClaudeCodeVersionResult {
  const attributionText = getFirstSystemText(input.system);
  const userAgentVersion = matchVersion(input.userAgent, USER_AGENT_VERSION);

  if (attributionText?.startsWith(ATTRIBUTION_PREFIX)) {
    const fields = attributionText.slice(ATTRIBUTION_PREFIX.length).trimStart();
    const version = matchVersion(fields, ATTRIBUTION_VERSION);
    if (!version) {
      return { source: "none", userAgentMismatch: false };
    }

    return {
      source: "system",
      version,
      userAgentMismatch: userAgentVersion !== undefined && userAgentVersion !== version,
    };
  }

  if (userAgentVersion) {
    return {
      source: "user-agent",
      version: userAgentVersion,
      userAgentMismatch: false,
    };
  }

  return { source: "none", userAgentMismatch: false };
}

export function parseVersionRange(input: VersionRangeInput): VersionRange {
  const min = parseOptionalVersion(input.min, "minimum");
  const max = parseOptionalVersion(input.max, "maximum");

  if (min && max && compare(min, max) > 0) {
    throw new Error("Claude Code minimum version must not exceed the maximum version");
  }

  return {
    ...(min ? { min } : {}),
    ...(max ? { max } : {}),
  };
}

export function assertClaudeCodeVersionAllowed(version: string, range: VersionRange): void {
  if (range.min && compare(version, range.min) < 0) {
    throw new ClaudeCodeVersionRangeError("below");
  }
  if (range.max && compare(version, range.max) > 0) {
    throw new ClaudeCodeVersionRangeError("above");
  }
}

function getFirstSystemText(system: ClaudeCodeVersionInput["system"]): string | undefined {
  if (!Array.isArray(system)) {
    return undefined;
  }

  const first = system[0];
  return first?.type === "text" && typeof first.text === "string" ? first.text : undefined;
}

function matchVersion(value: string | undefined, pattern: RegExp): string | undefined {
  const candidate = value?.match(pattern)?.[1];
  return candidate !== undefined && STRICT_SEMVER.test(candidate) && valid(candidate) === candidate
    ? candidate
    : undefined;
}

function parseOptionalVersion(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!STRICT_SEMVER.test(value) || valid(value) !== value) {
    throw new Error(`Claude Code ${name} version must be a valid semantic version`);
  }
  return value;
}
