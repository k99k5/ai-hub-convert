import { domainToASCII } from "node:url";

export function matchesSearchDomain(url: string, domains: readonly string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((raw) => {
    const normalized = raw
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "");
    if (/[/\\?#@:\s]/.test(normalized)) return false;
    const domain = domainToASCII(normalized);
    return domain !== "" && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}
