import { Match, Option, Redacted, Result, SemVer } from "effect"
import { ProxyConfig, ProxyInvalid } from "./http-proxy.entity.js"
import type { HttpProxyOptions, NoProxyRule, ProxyEnvironment } from "./http-proxy.entity.js"

/** A value that is set: present and not blank. */
const present = (value: string | undefined): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(value), (text) => text.trim().length > 0)

/** The first of `values` that is set, with the name it was read under. */
const firstSet = (values: ReadonlyArray<readonly [string, string | undefined]>): Option.Option<readonly [string, string]> =>
  Option.fromNullishOr(values.flatMap(([name, value]) => Option.toArray(Option.map(present(value), (text) => [name, text.trim()] as const)))[0])

/**
 * Credentials in the URLs of `text` (`scheme://user:pass@host`) replaced by
 * `<redacted>`, for error messages that may quote a proxy URL.
 */
export const redactCredentials = (text: string): string =>
  text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1<redacted>@")

/** A proxy URL as a message may show it: its scheme and host, its credentials (if any) as `<redacted>`. */
export const displayProxy = (url: Redacted.Redacted<string>): string => {
  const raw = Redacted.value(url)
  if (!URL.canParse(raw)) return redactCredentials(raw)
  const parsed = new URL(raw)
  const userinfo = parsed.username.length > 0 || parsed.password.length > 0 ? "<redacted>@" : ""
  return `${parsed.protocol}//${userinfo}${parsed.host}`
}

/**
 * One proxy URL, checked: `None` when blank; a value without a scheme
 * (`proxy.corp:8080`) reads as `http://`; anything that is not an `http://`
 * or `https://` URL with a host fails with `ProxyInvalid` naming `source`,
 * credentials redacted.
 */
export const proxyUrl = (raw: string, source: string): Result.Result<Option.Option<Redacted.Redacted<string>>, ProxyInvalid> => {
  const text = raw.trim()
  if (text.length === 0) return Result.succeed(Option.none())
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  if (!URL.canParse(candidate)) {
    return Result.fail(new ProxyInvalid({ source, message: `${source} is not a proxy URL: ${redactCredentials(candidate)}` }))
  }
  const url = new URL(candidate)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Result.fail(new ProxyInvalid({
      source,
      message: `${source} is a ${url.protocol}// proxy; only http:// and https:// proxies are supported (SOCKS is not)`,
    }))
  }
  if (url.hostname.length === 0) {
    return Result.fail(new ProxyInvalid({ source, message: `${source} names no proxy host: ${redactCredentials(candidate)}` }))
  }
  return Result.succeed(Option.some(Redacted.make(url.href)))
}

/** The IPv4 address `text` spells, as its 4 bytes. */
export const parseIpv4 = (text: string): Option.Option<ReadonlyArray<number>> => {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return Option.none()
  const bytes = text.split(".").map(Number)
  return bytes.every((byte) => byte <= 255) ? Option.some(bytes) : Option.none()
}

/** The groups of an IPv6 address whose last 32 bits may be written as IPv4 (`::ffff:1.2.3.4`), in hex. */
const ipv6Groups = (text: string): Option.Option<string> => {
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (tail === null) return Option.some(text)
  const dotted = tail[1] ?? ""
  return Option.map(parseIpv4(dotted), (bytes) => {
    const [a = 0, b = 0, c = 0, d = 0] = bytes
    return `${text.slice(0, text.length - dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  })
}

/** The IPv6 address `text` spells (brackets and a zone id allowed), as its 16 bytes. */
export const parseIpv6 = (text: string): Option.Option<ReadonlyArray<number>> =>
  Option.flatMap(ipv6Groups((text.replace(/^\[|\]$/g, "").split("%")[0] ?? "").toLowerCase()), (address) => {
    const halves = address.split("::")
    if (halves.length > 2 || !address.includes(":")) return Option.none()
    const groupsOf = (half: string | undefined) => half === undefined || half.length === 0 ? [] : half.split(":")
    const head = groupsOf(halves[0])
    const tail = groupsOf(halves[1])
    const missing = 8 - head.length - tail.length
    if (halves.length === 1 ? missing !== 0 : missing < 1) return Option.none()
    const groups = [...head, ...Array.from({ length: halves.length === 1 ? 0 : missing }, () => "0"), ...tail]
    return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
      ? Option.some(groups.flatMap((group) => {
        const value = Number.parseInt(group, 16)
        return [value >> 8, value & 0xff]
      }))
      : Option.none()
  })

/** The address a host names, if it is an IP literal: its bytes (4 or 16). */
const addressOf = (host: string): Option.Option<ReadonlyArray<number>> =>
  Option.orElse(parseIpv4(host), () => parseIpv6(host))

/** Whether `address` lies in the range of `network`'s first `prefix` bits (both of one family). */
const inRange = (network: ReadonlyArray<number>, prefix: number, address: ReadonlyArray<number>): boolean =>
  network.length === address.length && network.every((byte, index) => {
    const bits = Math.min(8, Math.max(0, prefix - index * 8))
    const mask = bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff
    return (byte & mask) === ((address[index] ?? 0) & mask)
  })

/** A host is loopback: `localhost` (and its subdomains), `127.0.0.0/8`, `::1`, or IPv4 loopback mapped into IPv6. */
export const isLoopback = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  return Option.match(addressOf(host), {
    onNone: () => false,
    onSome: (bytes) => bytes.length === 4
      ? bytes[0] === 127
      : inRange([...Array.from({ length: 15 }, () => 0), 1], 128, bytes)
        || inRange([...Array.from({ length: 10 }, () => 0), 0xff, 0xff, 127, 0, 0, 0], 104, bytes),
  })
}

/** One NO_PROXY entry, parsed; `None` for one that cannot match anything (an invalid range). */
const parseRule = (entry: string): Option.Option<NoProxyRule> => {
  const text = entry.toLowerCase()
  if (text === "*") return Option.some({ _tag: "Everything" })
  if (text.includes("/")) {
    const [address = "", bits = ""] = text.split("/", 2)
    return Option.flatMap(addressOf(address.replace(/^\[|\]$/g, "")), (bytes) => {
      const prefix = Number(bits)
      return /^\d+$/.test(bits) && prefix <= bytes.length * 8
        ? Option.some<NoProxyRule>({ _tag: "Address", bytes, prefix, port: Option.none() })
        : Option.none()
    })
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text)
  const withPort = bracketed === null && (text.match(/:/g) ?? []).length === 1 ? /^(.+):(\d+)$/.exec(text) : null
  const host = bracketed?.[1] ?? withPort?.[1] ?? text
  const port = Option.map(Option.fromNullishOr(bracketed?.[2] ?? withPort?.[2]), Number)
  return Option.some(Option.match(addressOf(host), {
    onSome: (bytes): NoProxyRule => ({ _tag: "Address", bytes, prefix: bytes.length * 8, port }),
    onNone: (): NoProxyRule => ({ _tag: "Domain", name: host.replace(/^\*?\./, "").replace(/\.$/, ""), port }),
  }))
}

/** A NO_PROXY value (entries separated by commas or white space), parsed. */
export const parseNoProxy = (value: string): ReadonlyArray<NoProxyRule> =>
  value.split(/[\s,]+/).filter((entry) => entry.length > 0).flatMap((entry) => Option.toArray(parseRule(entry)))

const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "ws:": 80, "https:": 443, "wss:": 443 }

/** Whether a NO_PROXY rule sends `target` direct. */
export const bypassesProxy = (rules: ReadonlyArray<NoProxyRule>, target: URL): boolean => {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  const port = target.port.length > 0 ? Number(target.port) : DEFAULT_PORTS[target.protocol] ?? 0
  const address = addressOf(host)
  const portMatches = (wanted: Option.Option<number>) => Option.match(wanted, { onNone: () => true, onSome: (value) => value === port })
  return rules.some(Match.type<NoProxyRule>().pipe(
    Match.tag("Everything", () => true),
    Match.tag("Domain", (rule) => portMatches(rule.port) && (host === rule.name || host.endsWith(`.${rule.name}`))),
    Match.tag("Address", (rule) => portMatches(rule.port) && Option.exists(address, (bytes) => inRange(rule.bytes, rule.prefix, bytes))),
    Match.exhaustive,
  ))
}

/** Whether NO_PROXY rules exempt every host (`*`). */
const exemptsEverything = (rules: ReadonlyArray<NoProxyRule>): boolean => rules.some((rule) => rule._tag === "Everything")

/**
 * The proxy settings of the models plugin's options over the environment's:
 * an explicit `proxy` serves every target; otherwise `https_proxy` (then
 * `HTTPS_PROXY`) serves `https:` targets, `http_proxy` (then `HTTP_PROXY`)
 * `http:` ones, and an `https:` target falls back to the `http:` proxy, as
 * undici's environment proxy (Node's, under `NODE_USE_ENV_PROXY`) does. The
 * direct hosts are `no_proxy` (then `NO_PROXY`) and the `noProxy` option
 * together; with `*` among them the environment's proxy variables are not
 * read at all. Lower case comes first, as undici and curl read them. A proxy
 * URL that cannot be used fails with `ProxyInvalid`.
 */
export const resolveProxy = (options: HttpProxyOptions, env: ProxyEnvironment): Result.Result<ProxyConfig, ProxyInvalid> =>
  Result.gen(function* () {
    const explicit = yield* proxyUrl(
      options.proxy === undefined ? "" : Redacted.isRedacted(options.proxy) ? Redacted.value(options.proxy) : options.proxy,
      "the proxy option",
    )
    const noProxy = parseNoProxy([
      ...Option.toArray(Option.map(firstSet([["no_proxy", env.no_proxy], ["NO_PROXY", env.NO_PROXY]]), ([, value]) => value)),
      options.noProxy ?? "",
    ].join(","))
    // With `*` nothing is proxied: the environment's proxy variables are not even read (a SOCKS one would be refused).
    const off = exemptsEverything(noProxy)
    const fromEnv = (names: ReadonlyArray<readonly [string, string | undefined]>) =>
      Option.match(off ? Option.none() : firstSet(names), {
        onNone: () => Result.succeed(Option.none<Redacted.Redacted<string>>()),
        onSome: ([name, value]) => proxyUrl(value, name),
      })
    const http = Option.isSome(explicit) ? explicit : yield* fromEnv([["http_proxy", env.http_proxy], ["HTTP_PROXY", env.HTTP_PROXY]])
    const https = Option.isSome(explicit) ? explicit : Option.orElse(yield* fromEnv([["https_proxy", env.https_proxy], ["HTTPS_PROXY", env.HTTPS_PROXY]]), () => http)
    return new ProxyConfig({ https, http, noProxy })
  })

/** Whether any target can go through a proxy. */
export const usesProxy = (config: ProxyConfig): boolean => Option.isSome(config.https) || Option.isSome(config.http)

/** Whether the setting turns the proxy off for every host (`*` in `noProxy` or `NO_PROXY`). */
export const turnsProxyOff = (config: ProxyConfig): boolean => exemptsEverything(config.noProxy)

/**
 * The proxy a request to `target` goes through, or `None` for direct:
 * loopback hosts and the `noProxy` hosts go direct; `https:` and `wss:`
 * targets use the https proxy, `http:` and `ws:` ones the http proxy.
 */
export const proxyFor = (target: URL, config: ProxyConfig): Option.Option<Redacted.Redacted<string>> => {
  if (isLoopback(target.hostname) || bypassesProxy(config.noProxy, target)) return Option.none()
  if (target.protocol === "https:" || target.protocol === "wss:") return config.https
  if (target.protocol === "http:" || target.protocol === "ws:") return config.http
  return Option.none()
}

/** Whether a runtime `version` (`24.16.0`, `1.3.6`) is at least `minimum`; an unreadable one is not. */
export const atLeastVersion = (version: string, minimum: string): boolean =>
  Result.match(Result.all([SemVer.parse(version.replace(/^v/, "")), SemVer.parse(minimum)]), {
    onFailure: () => false,
    onSuccess: ([current, wanted]) => SemVer.isGreaterThanOrEqualTo(current, wanted),
  })
