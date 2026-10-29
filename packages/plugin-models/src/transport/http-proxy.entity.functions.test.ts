import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Option, Redacted, Result } from "effect"
import { ProxyInvalid } from "./http-proxy.entity.js"
import type { ProxyConfig, ProxyEnvironment } from "./http-proxy.entity.js"
import {
  atLeastVersion,
  bypassesProxy,
  displayProxy,
  isLoopback,
  parseIpv4,
  parseIpv6,
  parseNoProxy,
  proxyFor,
  proxyUrl,
  redactCredentials,
  resolveProxy,
  turnsProxyOff,
} from "./http-proxy.entity.functions.js"

const resolved = (options: Parameters<typeof resolveProxy>[0], env: ProxyEnvironment = {}): ProxyConfig =>
  Result.getOrThrow(resolveProxy(options, env))

const refused = (options: Parameters<typeof resolveProxy>[0], env: ProxyEnvironment = {}): ProxyInvalid =>
  Result.getOrThrow(Result.flip(resolveProxy(options, env)))

const shown = (url: Option.Option<Redacted.Redacted<string>>) => Option.getOrNull(Option.map(url, Redacted.value))

const target = (config: ProxyConfig, url: string) => shown(proxyFor(new URL(url), config))

describe("resolveProxy: where the proxy comes from", () => {
  test("the proxy option wins over the environment, for every scheme", () => {
    const config = resolved({ proxy: "http://option:3128" }, { HTTPS_PROXY: "http://https-env:1", HTTP_PROXY: "http://http-env:2" })
    expect(target(config, "https://api.example.com/v1")).toBe("http://option:3128/")
    expect(target(config, "http://api.example.com/v1")).toBe("http://option:3128/")
  })

  test("a Redacted proxy option is read through", () => {
    expect(target(resolved({ proxy: Redacted.make("http://user:secret@option:3128") }), "https://api.example.com")).toBe("http://user:secret@option:3128/")
  })

  test.each([
    // Lower case first, as undici (Node's environment proxy) and curl read them.
    [{ HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:1" }, "http://lower:1/"],
    [{ HTTPS_PROXY: "http://upper:1" }, "http://upper:1/"],
    [{ HTTPS_PROXY: "http://upper:1", https_proxy: "" }, "http://upper:1/"],
    [{ HTTP_PROXY: "http://http-only:2" }, "http://http-only:2/"],
    [{ HTTP_PROXY: "http://upper:2", http_proxy: "http://lower:2" }, "http://lower:2/"],
    [{}, null],
  ] satisfies ReadonlyArray<readonly [ProxyEnvironment, string | null]>)("https targets from the environment %p", (env, expected) => {
    expect(target(resolved({}, env), "https://api.example.com")).toBe(expected)
  })

  test("http targets take http_proxy (then HTTP_PROXY), never HTTPS_PROXY", () => {
    expect(target(resolved({}, { HTTPS_PROXY: "http://secure:1" }), "http://api.example.com")).toBeNull()
    expect(target(resolved({}, { HTTPS_PROXY: "http://secure:1", http_proxy: "http://plain:2" }), "http://api.example.com")).toBe("http://plain:2/")
  })

  test("a value without a scheme reads as http://", () => {
    expect(target(resolved({}, { HTTPS_PROXY: "proxy.corp:8080" }), "https://api.example.com")).toBe("http://proxy.corp:8080/")
    expect(target(resolved({ proxy: "user:pass@proxy.corp:8080" }), "https://api.example.com")).toBe("http://user:pass@proxy.corp:8080/")
  })

  test("an https:// proxy is kept", () => {
    expect(target(resolved({ proxy: "https://secure-proxy:443" }), "https://api.example.com")).toBe("https://secure-proxy/")
  })

  test("a non-http(s) proxy is refused with a typed error naming its source", () => {
    const socks = refused({}, { HTTPS_PROXY: "socks5://user:secret@proxy:1080" })
    expect(socks).toBeInstanceOf(ProxyInvalid)
    expect(socks.source).toBe("HTTPS_PROXY")
    expect(socks.message).toContain("socks5:")
    expect(socks.message).not.toContain("secret")
    expect(refused({ proxy: "ftp://proxy:21" }).source).toBe("the proxy option")
  })

  test("an unparseable proxy is refused without repeating its credentials", () => {
    const invalid = refused({ proxy: "http://user:secret@bad host:80" })
    expect(invalid.source).toBe("the proxy option")
    expect(invalid.message).toContain("is not a proxy URL")
    expect(invalid.message).not.toContain("secret")
    expect(refused({}, { http_proxy: "http://:80" }).source).toBe("http_proxy")
  })

  test("noProxy \"*\" turns the proxy off without reading the environment's proxies", () => {
    const config = resolved({ noProxy: "*" }, { HTTPS_PROXY: "socks5://proxy:1080", HTTP_PROXY: "http://proxy:3128" })
    expect(Option.isNone(config.https) && Option.isNone(config.http)).toBe(true)
    expect(target(resolved({}, { NO_PROXY: "*", HTTPS_PROXY: "socks5://proxy:1080" }), "https://api.example.com")).toBeNull()
  })

  test("blank settings are no proxy", () => {
    const config = resolved({ proxy: "  ", noProxy: "" }, { HTTPS_PROXY: " " })
    expect(Option.isNone(config.https) && Option.isNone(config.http)).toBe(true)
  })

  test("the noProxy option adds to no_proxy (lower case before upper case)", () => {
    const config = resolved({ proxy: "http://proxy:1", noProxy: "internal.example" }, { no_proxy: "corp.example", NO_PROXY: "ignored.example" })
    expect(target(config, "https://api.internal.example")).toBeNull()
    expect(target(config, "https://corp.example")).toBeNull()
    expect(target(config, "https://ignored.example")).toBe("http://proxy:1/")
    expect(target(resolved({ proxy: "http://proxy:1" }, { NO_PROXY: "upper.example" }), "https://upper.example")).toBeNull()
  })

  test("turnsProxyOff: \"*\" in the noProxy option or NO_PROXY", () => {
    expect(turnsProxyOff(resolved({ noProxy: "*" }))).toBe(true)
    expect(turnsProxyOff(resolved({}, { NO_PROXY: "corp.example,*" }))).toBe(true)
    expect(turnsProxyOff(resolved({ proxy: "http://proxy:1", noProxy: "corp.example" }))).toBe(false)
  })
})

describe("proxyFor: which targets go direct", () => {
  const config = resolved({ proxy: "http://proxy:3128" })

  test.each([
    "http://localhost:8080/v1", "http://LOCALHOST/", "http://api.localhost/", "http://127.0.0.1:11434/v1", "http://127.8.9.10/",
    "http://[::1]:8080/", "http://[::ffff:127.0.0.1]/", "ws://localhost:9/", "wss://127.0.0.1/",
  ])("loopback always goes direct: %s", (url) => {
    expect(target(config, url)).toBeNull()
  })

  test("everything else goes through the proxy; unknown schemes go direct", () => {
    expect(target(config, "https://api.anthropic.com/v1/messages")).toBe("http://proxy:3128/")
    expect(target(config, "wss://chatgpt.com/backend-api/codex/responses")).toBe("http://proxy:3128/")
    expect(target(config, "http://10.0.0.5/")).toBe("http://proxy:3128/")
    expect(target(config, "file:///etc/hosts")).toBeNull()
  })

  test("loopback stays direct even when NO_PROXY is empty and the proxy is explicit", () => {
    expect(target(resolved({ proxy: "http://proxy:3128", noProxy: "" }), "http://127.0.0.1:1234/")).toBeNull()
  })
})

describe("NO_PROXY rules", () => {
  const direct = (noProxy: string, url: string) => bypassesProxy(parseNoProxy(noProxy), new URL(url))

  test.each([
    ["*", "https://anything.example", true],
    ["a.example,*", "https://anything.example", true],
    ["example.com", "https://example.com", true],
    ["example.com", "https://api.example.com", true],
    ["example.com", "https://notexample.com", false],
    [".example.com", "https://example.com", true],
    [".example.com", "https://deep.api.example.com", true],
    ["*.example.com", "https://api.example.com", true],
    ["EXAMPLE.com", "https://Api.Example.COM", true],
    ["example.com:8443", "https://example.com:8443", true],
    ["example.com:8443", "https://example.com", false],
    ["example.com:443", "https://example.com", true],
    ["example.com:80", "http://example.com", true],
    ["10.1.2.3", "http://10.1.2.3:8080", true],
    ["10.1.2.3", "http://10.1.2.4", false],
    ["10.0.0.0/8", "http://10.200.3.4", true],
    ["10.0.0.0/8", "http://11.0.0.1", false],
    ["192.168.1.0/24", "http://192.168.1.77", true],
    ["192.168.1.0/24", "http://192.168.2.1", false],
    ["172.16.0.0/12", "http://172.31.255.255", true],
    ["172.16.0.0/12", "http://172.32.0.1", false],
    ["0.0.0.0/0", "http://8.8.8.8", true],
    ["fd00::/8", "http://[fd12:3456::1]", true],
    ["fd00::/8", "http://[fe80::1]", false],
    ["2001:db8::1", "http://[2001:db8:0:0:0:0:0:1]", true],
    ["[2001:db8::1]", "http://[2001:db8::1]", true],
    ["[2001:db8::1]:8080", "http://[2001:db8::1]:8080", true],
    ["[2001:db8::1]:8080", "http://[2001:db8::1]:9090", false],
    ["10.0.0.0/8", "http://ten.example", false],
    ["10.0.0.0/33", "http://10.0.0.1", false],
    ["internal.example, other.example  third.example", "https://third.example", true],
    ["", "https://example.com", false],
  ] satisfies ReadonlyArray<readonly [string, string, boolean]>)("%p sends %p direct: %p", (noProxy, url, expected) => {
    expect(direct(noProxy, url)).toBe(expected)
  })

  test("an address rule covers exactly its own prefix (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 32 }), fc.integer({ min: 0, max: 0xffffffff }), (network, prefix, address) => {
      const dotted = (value: number) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".")
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
      expect(direct(`${dotted(network)}/${prefix}`, `http://${dotted(address)}/`)).toBe(((network & mask) >>> 0) === ((address & mask) >>> 0))
    }))
  })
})

describe("IP literals", () => {
  test("IPv4", () => {
    expect(Option.getOrNull(parseIpv4("192.168.0.1"))).toEqual([192, 168, 0, 1])
    expect(Option.isNone(parseIpv4("256.1.1.1"))).toBe(true)
    expect(Option.isNone(parseIpv4("1.2.3"))).toBe(true)
  })

  test("IPv6, with ::, brackets, a zone and an IPv4 tail", () => {
    expect(Option.getOrNull(parseIpv6("::1"))).toEqual([...Array.from({ length: 15 }, () => 0), 1])
    expect(Option.getOrNull(parseIpv6("[fe80::1%eth0]"))).toEqual([0xfe, 0x80, ...Array.from({ length: 13 }, () => 0), 1])
    expect(Option.getOrNull(parseIpv6("::ffff:10.0.0.1"))).toEqual([...Array.from({ length: 10 }, () => 0), 0xff, 0xff, 10, 0, 0, 1])
    expect(Option.isNone(parseIpv6("1::2::3"))).toBe(true)
    expect(Option.isNone(parseIpv6("12345::1"))).toBe(true)
    expect(Option.isNone(parseIpv6("example.com"))).toBe(true)
    expect(Option.isNone(parseIpv6("1:2:3:4:5:6:7"))).toBe(true)
  })

  test("any IPv6 address round-trips through its expanded hex form (property)", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }), (groups) => {
      const text = groups.map((group) => group.toString(16)).join(":")
      expect(Option.getOrNull(parseIpv6(text))).toEqual(groups.flatMap((group) => [group >> 8, group & 0xff]))
      // The URL parser's compressed form names the same address.
      expect(Option.getOrNull(parseIpv6(new URL(`http://[${text}]/`).hostname))).toEqual(groups.flatMap((group) => [group >> 8, group & 0xff]))
    }))
  })

  test("loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true)
    expect(isLoopback("[::1]")).toBe(true)
    expect(isLoopback("localhost.")).toBe(true)
    expect(isLoopback("10.0.0.1")).toBe(false)
    expect(isLoopback("[::2]")).toBe(false)
    expect(isLoopback("localhost.example.com")).toBe(false)
  })
})

describe("credentials never show", () => {
  test("in a displayed proxy", () => {
    expect(displayProxy(Redacted.make("http://user:secret@proxy.corp:3128/"))).toBe("http://<redacted>@proxy.corp:3128")
    expect(displayProxy(Redacted.make("http://proxy.corp:3128/"))).toBe("http://proxy.corp:3128")
  })

  test("in error text", () => {
    expect(redactCredentials("connect to http://user:secret@proxy:1 failed; retry https://token@other:2/path")).toBe(
      "connect to http://<redacted>@proxy:1 failed; retry https://<redacted>@other:2/path",
    )
    expect(redactCredentials("no URL here: user@example.com")).toBe("no URL here: user@example.com")
  })

  test("in a resolved setting printed whole", () => {
    expect(String(resolved({ proxy: "http://user:secret@proxy:1" }))).not.toContain("secret")
    expect(JSON.stringify(resolved({ proxy: "http://user:secret@proxy:1" }))).not.toContain("secret")
  })

  test("for any password (property)", () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z0-9._~-]{1,24}$/), (password) => {
      const raw = `http://someone:${password}@proxy.example:3128`
      expect(redactCredentials(`failed: ${raw}`)).not.toContain(`:${password}@`)
      expect(displayProxy(Redacted.make(raw))).not.toContain(`:${password}@`)
    }))
  })
})

describe("proxyUrl", () => {
  test("blank is none; a host is required", () => {
    expect(Option.isNone(Result.getOrThrow(proxyUrl("", "x")))).toBe(true)
    expect(Result.isFailure(proxyUrl("http://", "x"))).toBe(true)
  })
})

describe("atLeastVersion", () => {
  test.each([
    ["1.3.6", "1.3.6", true],
    ["1.3.14", "1.3.6", true],
    ["1.4.0", "1.3.6", true],
    ["1.3.5", "1.3.6", false],
    ["1.3.0", "1.3.6", false],
    ["1.3.6-canary.1", "1.3.6", false],
    ["v24.16.0", "24.5.0", true],
    ["24.4.1", "24.5.0", false],
    ["not a version", "1.0.0", false],
  ] satisfies ReadonlyArray<readonly [string, string, boolean]>)("%p >= %p: %p", (version, minimum, expected) => {
    expect(atLeastVersion(version, minimum)).toBe(expected)
  })
})
