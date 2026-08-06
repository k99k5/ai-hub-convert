export type CredentialHeaders = Readonly<Record<string, string | string[] | undefined>>;

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export function extractAnthropicApiKey(headers: CredentialHeaders): string {
  const apiKey = getSingleHeader(headers["x-api-key"]);
  const bearer = extractBearer(getSingleHeader(headers.authorization));

  if (apiKey && bearer && apiKey !== bearer) {
    throw new AuthenticationError("Conflicting API credentials");
  }

  const credential = apiKey || bearer;
  if (!credential) {
    throw new AuthenticationError("API credentials are required");
  }
  return credential;
}

export function extractResponsesApiKey(headers: CredentialHeaders): string {
  const bearer = extractBearer(getSingleHeader(headers.authorization));
  if (!bearer) {
    throw new AuthenticationError("A Bearer API credential is required");
  }
  return bearer;
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new AuthenticationError("Credential header must occur exactly once");
    }
    return value[0];
  }
  return value;
}

function extractBearer(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) {
    throw new AuthenticationError("Authorization must use the Bearer scheme");
  }
  return match[1];
}
