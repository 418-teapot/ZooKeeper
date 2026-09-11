/**
 * Unit tests for the SSRF guard.
 *
 * DNS resolution is injected so every case runs deterministically without
 * touching the network. IP-literal cases never invoke the resolver at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SsrfError, validateRemoteUrl } from "./ssrf.js";

/**
 * Build a resolver that always returns the given addresses.
 */
function fixedLookup(addresses: string[]) {
  return async () => addresses;
}

describe("validateRemoteUrl protocols", () => {
  it("rejects non-http(s) schemes", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/file",
      "javascript:alert(1)",
      "data:text/html,hi",
    ]) {
      await assert.rejects(
        () => validateRemoteUrl(url),
        (err: unknown) =>
          err instanceof SsrfError &&
          /Unsupported URL scheme/.test(err.message),
        `expected ${url} to be rejected`,
      );
    }
  });

  it("rejects malformed URLs", async () => {
    await assert.rejects(
      () => validateRemoteUrl("not a url"),
      (err: unknown) =>
        err instanceof SsrfError && /Invalid URL/.test(err.message),
    );
  });
});

describe("validateRemoteUrl loopback hostnames", () => {
  it("rejects localhost and its subdomains", async () => {
    for (const url of [
      "http://localhost/",
      "http://localhost:8080/admin",
      "http://foo.localhost/",
      "http://localhost./",
      "https://LOCALHOST/",
    ]) {
      await assert.rejects(
        () => validateRemoteUrl(url),
        (err: unknown) =>
          err instanceof SsrfError && /loopback hostnames/.test(err.message),
        `expected ${url} to be rejected`,
      );
    }
  });
});

describe("validateRemoteUrl IPv4 literals", () => {
  it("rejects loopback, private, link-local, and reserved addresses", async () => {
    for (const ip of [
      "0.0.0.0",
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      await assert.rejects(
        () => validateRemoteUrl(`http://${ip}/`),
        (err: unknown) =>
          err instanceof SsrfError && /not a public address/.test(err.message),
        `expected ${ip} to be rejected`,
      );
    }
  });

  it("accepts public IPv4 literals", async () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) {
      const url = await validateRemoteUrl(`http://${ip}/path`);
      assert.equal(url.hostname, ip);
    }
  });
});

describe("validateRemoteUrl IPv6 literals", () => {
  it("rejects loopback, link-local, unique-local, and mapped addresses", async () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "fec0::1",
      "ff02::1",
      "2001:db8::1",
      "2002::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ]) {
      await assert.rejects(
        () => validateRemoteUrl(`http://[${ip}]/`),
        (err: unknown) => err instanceof SsrfError,
        `expected ${ip} to be rejected`,
      );
    }
  });

  it("rejects NAT64 well-known and local-use prefixes", async () => {
    for (const ip of ["64:ff9b::a00:1", "64:ff9b:1::1"]) {
      await assert.rejects(
        () => validateRemoteUrl(`http://[${ip}]/`),
        (err: unknown) => err instanceof SsrfError,
        `expected ${ip} to be rejected`,
      );
    }
  });

  it("accepts public IPv6 literals", async () => {
    const url = await validateRemoteUrl("http://[2606:4700:4700::1111]/");
    assert.equal(url.hostname, "[2606:4700:4700::1111]");
  });
});

describe("validateRemoteUrl DNS resolution", () => {
  it("accepts a hostname resolving only to public addresses", async () => {
    const url = await validateRemoteUrl("https://example.com/page", {
      lookup: fixedLookup([
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
      ]),
    });
    assert.equal(url.hostname, "example.com");
    assert.equal(url.pathname, "/page");
  });

  it("rejects a hostname resolving to a private address", async () => {
    await assert.rejects(
      () =>
        validateRemoteUrl("https://internal.example.com/", {
          lookup: fixedLookup(["10.1.2.3"]),
        }),
      (err: unknown) =>
        err instanceof SsrfError &&
        /resolves to non-public address 10\.1\.2\.3/.test(err.message),
    );
  });

  it("rejects when any resolved address is private", async () => {
    await assert.rejects(
      () =>
        validateRemoteUrl("https://mixed.example.com/", {
          lookup: fixedLookup(["93.184.216.34", "169.254.169.254"]),
        }),
      (err: unknown) => err instanceof SsrfError,
    );
  });

  it("reports a resolution failure", async () => {
    await assert.rejects(
      () =>
        validateRemoteUrl("https://nx.example.com/", {
          lookup: async () => {
            throw new Error("ENOTFOUND");
          },
        }),
      (err: unknown) =>
        err instanceof SsrfError &&
        /Could not resolve host "nx\.example\.com"/.test(err.message),
    );
  });

  it("rejects a hostname with no addresses", async () => {
    await assert.rejects(
      () =>
        validateRemoteUrl("https://empty.example.com/", {
          lookup: fixedLookup([]),
        }),
      (err: unknown) =>
        err instanceof SsrfError && /no addresses returned/.test(err.message),
    );
  });
});

describe("validateRemoteUrl normalization", () => {
  it("returns a normalized URL", async () => {
    const url = await validateRemoteUrl("HTTP://Example.COM:80/a?b=1#frag");
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "example.com");
    assert.equal(url.port, "");
    assert.equal(url.pathname, "/a");
    assert.equal(url.search, "?b=1");
  });
});
