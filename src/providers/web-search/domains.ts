export function matchesSearchDomain(url: string, domains: readonly string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((raw) => {
    const domain = raw
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "");
    return domain !== "" && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}
