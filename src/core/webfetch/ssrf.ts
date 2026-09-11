/**
 * SSRF guard for outbound HTTP requests.
 *
 * Restricts URLs to the http/https schemes and rejects hosts that are
 * loopback, private, link-local, or otherwise reserved. Hostnames are
 * resolved through an injectable resolver so callers can supply a
 * deterministic implementation in tests.
 *
 * Residual DNS TOCTOU risk: validation resolves the hostname and then the
 * fetch resolves it again independently.  A malicious resolver can return a
 * public address to the check and a private one to the fetch (DNS
 * rebinding), which this basic guard does not pin.  Callers that need
 * stronger isolation must connect to the validated address explicitly.
 *
 * @module
 */

import { lookup as dnsLookup } from "node:dns/promises";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Resolves a hostname to one or more IP address strings.
 *
 * Implementations should return every A/AAAA record so the caller can reject
 * a host when any of its addresses is non-public.
 */
export type LookupFn = (hostname: string) => Promise<string[]>;

/** Error raised when a URL fails SSRF validation. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Options for {@link validateRemoteUrl}. */
export interface ValidateRemoteUrlOptions {
  /**
   * Custom DNS resolver. Defaults to `node:dns/promises` lookup for all
   * address records.
   */
  lookup?: LookupFn;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** URL schemes accepted by the fetch pipeline. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// ---------------------------------------------------------------------------
// DNS resolution
// ---------------------------------------------------------------------------

/**
 * Resolve every A/AAAA record for a hostname using the Node DNS resolver.
 *
 * @param hostname - Hostname to resolve.
 * @returns One IP address string per record.
 */
async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * Render an unknown thrown value as a human-readable message.
 *
 * @param err - Caught value.
 * @returns The error message or the stringified value.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

/**
 * Parse a dotted-quad IPv4 address into its four octets.
 *
 * @param ip - Candidate IPv4 literal (no zone identifier).
 * @returns Octets when valid, otherwise `null`.
 */
function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Parse an IPv6 address into eight 16-bit groups.
 *
 * Supports `::` compression, a trailing embedded IPv4 literal, and an
 * optional zone identifier (which is stripped).
 *
 * @param ip - Candidate IPv6 literal.
 * @returns Eight groups when valid, otherwise `null`.
 */
function parseIpv6(ip: string): number[] | null {
  const zoneIndex = ip.indexOf("%");
  const address = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseSegment = (segment: string): number[] | null => {
    if (segment === "") return [];
    const tokens = segment.split(":");
    const groups: number[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (token.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const ipv4 = parseIpv4(token);
        if (!ipv4) return null;
        groups.push(
          ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0),
          ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0),
        );
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
        groups.push(Number.parseInt(token, 16));
      }
    }
    return groups;
  };

  const head = parseSegment(halves[0] ?? "");
  if (!head) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tail = parseSegment(halves[1] ?? "");
  if (!tail) return null;

  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;

  const padding = Array.from({ length: missing }, () => 0);
  return [...head, ...padding, ...tail];
}

/**
 * Test whether a dotted-quad IPv4 address belongs to a non-public range.
 *
 * Covers this-network, RFC1918 private, CGNAT, loopback, link-local
 * (including the cloud metadata endpoint), IETF protocol assignments,
 * TEST-NET documentation blocks, benchmarking, multicast, reserved, and
 * broadcast ranges.
 *
 * @param octets - Four IPv4 octets.
 * @returns `true` when the address must not be reached.
 */
function isBlockedIpv4(octets: number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  const c = octets[2] ?? 0;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

/**
 * Reconstruct an IPv4 address from the final two IPv6 groups.
 *
 * @param groups - Parsed IPv6 groups.
 * @returns The embedded IPv4 address as four octets.
 */
function embeddedIpv4(groups: number[]): number[] {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/**
 * Test whether an IPv6 address belongs to a non-public range.
 *
 * @param groups - Eight IPv6 groups.
 * @returns `true` when the address must not be reached.
 */
function isBlockedIpv6(groups: number[]): boolean {
  const g0 = groups[0] ?? 0;
  const g1 = groups[1] ?? 0;

  if (groups.every((group) => group === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && groups[7] === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 docs
  if (g0 === 0x2002) return true; // 2002::/16 6to4
  if (g0 === 0x0100 && g1 === 0 && groups[3] === 0) return true; // 100::/64
  // 64:ff9b::/96 NAT64 well-known prefix and the 64:ff9b:1::/48
  // local-use NAT64 prefix (RFC 8215) both start with 64:ff9b.
  if (g0 === 0x0064 && g1 === 0xff9b) return true;

  const isV4Embedded =
    g0 === 0 &&
    g1 === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0;

  // ::ffff:a.b.c.d IPv4-mapped and ::a.b.c.d IPv4-compatible.
  if (isV4Embedded && (groups[5] === 0xffff || groups[5] === 0)) {
    return isBlockedIpv4(embeddedIpv4(groups));
  }

  return false;
}

/**
 * Test whether an IP literal resolves to a blocked range.
 *
 * Unparseable input is treated as blocked so that a malformed resolver
 * response fails closed.
 *
 * @param ip - IPv4 or IPv6 literal.
 * @returns `true` when the address must not be reached.
 */
function isBlockedIp(ip: string): boolean {
  const ipv4 = parseIpv4(ip);
  if (ipv4) return isBlockedIpv4(ipv4);

  const ipv6 = parseIpv6(ip);
  if (ipv6) return isBlockedIpv6(ipv6);

  return true;
}

/**
 * Test whether a hostname is a loopback alias rather than a DNS name.
 *
 * @param hostname - URL hostname (brackets already stripped).
 * @returns `true` for `localhost` and any `*.localhost` name.
 */
function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}

/**
 * Strip the brackets WHATWG URLs wrap around IPv6 hostnames.
 *
 * @param hostname - URL hostname.
 * @returns The bare hostname.
 */
function stripBrackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a remote URL for safe outbound fetching.
 *
 * Rejects non-http(s) schemes, loopback hostnames, and hosts that are — or
 * resolve to — a private, reserved, or otherwise non-public address.
 *
 * @param rawUrl - The URL supplied by the caller or a redirect target.
 * @param options - Optional DNS resolver override.
 * @returns The parsed, normalized URL.
 * @throws {SsrfError} When the URL is malformed or points at a blocked host.
 */
export async function validateRemoteUrl(
  rawUrl: string,
  options: ValidateRemoteUrlOptions = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    const scheme = parsed.protocol.replace(/:$/, "");
    throw new SsrfError(
      `Unsupported URL scheme "${scheme}": only http and https are allowed.`,
    );
  }

  const hostname = stripBrackets(parsed.hostname);
  if (hostname === "") {
    throw new SsrfError(`Invalid URL (missing host): ${rawUrl}`);
  }

  if (isLoopbackHostname(hostname)) {
    throw new SsrfError(
      `Blocked host "${hostname}": loopback hostnames are not allowed.`,
    );
  }

  if (parseIpv4(hostname) || parseIpv6(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfError(
        `Blocked host "${hostname}": address is not a public address.`,
      );
    }
    return parsed;
  }

  const lookup = options.lookup ?? defaultLookup;
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    throw new SsrfError(
      `Could not resolve host "${hostname}": ${errorMessage(err)}`,
    );
  }

  if (addresses.length === 0) {
    throw new SsrfError(
      `Could not resolve host "${hostname}": no addresses returned.`,
    );
  }

  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new SsrfError(
        `Blocked host "${hostname}": resolves to non-public address ${address}.`,
      );
    }
  }

  return parsed;
}
