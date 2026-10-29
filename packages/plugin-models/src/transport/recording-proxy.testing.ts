import { connect, createServer } from "node:net"
import type { Server, Socket } from "node:net"

/** One request a `RecordingProxy` received: a CONNECT tunnel (`host:port`) or an absolute-form request (its URL). */
export interface ProxiedRequest {
  readonly kind: "connect" | "absolute"
  readonly target: string
  readonly authorization: string | null
}

export interface RecordingProxy {
  readonly url: string
  readonly port: number
  readonly seen: ReadonlyArray<ProxiedRequest>
  readonly close: () => Promise<void>
}

/** Where a proxied host really is: `*.invalid` names (which no DNS resolves) are this machine; any other host is refused. */
const localHost = (host: string): string | null => host.endsWith(".invalid") ? "127.0.0.1" : null

/** Pipe two sockets into each other, each closing the other. */
const splice = (client: Socket, upstream: Socket) => {
  upstream.on("error", () => client.destroy())
  client.on("error", () => upstream.destroy())
  upstream.pipe(client)
  client.pipe(upstream)
}

/** Handle one client connection once its request head has arrived. */
const handle = (client: Socket, head: string, rest: Buffer, seen: Array<ProxiedRequest>) => {
  const [line = "", ...headers] = head.split("\r\n")
  const [method = "", target = ""] = line.split(" ")
  const authorization = headers.find((header) => /^proxy-authorization:/i.test(header))?.replace(/^[^:]*:\s*/, "") ?? null
  if (method === "CONNECT") {
    seen.push({ kind: "connect", target, authorization })
    const at = target.lastIndexOf(":")
    const host = localHost(target.slice(0, at).replace(/^\[|\]$/g, ""))
    if (host === null) return client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n")
    const upstream = connect(Number(target.slice(at + 1)), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      upstream.write(rest)
      splice(client, upstream)
    })
    return upstream.on("error", () => client.destroy())
  }
  seen.push({ kind: "absolute", target, authorization })
  const url = URL.canParse(target) ? new URL(target) : null
  const host = url === null ? null : localHost(url.hostname)
  if (url === null || host === null) return client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
  // Origin form upstream; one request per connection, so every request is seen.
  const kept = headers.filter((header) => !/^(proxy-[^:]*|connection|keep-alive):/i.test(header))
  const upstream = connect(Number(url.port || 80), host, () => {
    upstream.write([`${method} ${url.pathname}${url.search} HTTP/1.1`, ...kept, "connection: close", "", ""].join("\r\n"))
    upstream.write(rest)
    splice(client, upstream)
  })
  return upstream.on("error", () => client.destroy())
}

/**
 * A recording HTTP proxy on 127.0.0.1 for tests, over raw sockets (so no
 * environment proxy applies to it): it records every request, opens CONNECT
 * tunnels and forwards absolute-form requests to `*.invalid` hosts on this
 * machine (the port as asked), and refuses every other host with 403, so a
 * test never reaches the network. `reset: true` makes it close every
 * connection as soon as it opens; `authenticate: true` answers every request
 * with 407 (Proxy Authentication Required).
 */
export const startRecordingProxy = (options: { readonly reset?: boolean; readonly authenticate?: boolean } = {}): Promise<RecordingProxy> => {
  const seen: Array<ProxiedRequest> = []
  const clients: Array<Socket> = []
  const server: Server = createServer((client) => {
    if (options.reset === true) return client.destroy()
    clients.push(client)
    const pending: Array<Buffer> = []
    const onData = (chunk: Buffer) => {
      pending.push(chunk)
      const all = Buffer.concat(pending)
      const end = all.indexOf("\r\n\r\n")
      if (end < 0) return
      client.off("data", onData)
      const head = all.subarray(0, end).toString("latin1")
      if (options.authenticate === true) {
        const [method = "", target = ""] = (head.split("\r\n")[0] ?? "").split(" ")
        seen.push({ kind: method === "CONNECT" ? "connect" : "absolute", target, authorization: null })
        return client.end("HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm=\"test\"\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
      }
      handle(client, head, all.subarray(end + 4), seen)
    }
    client.on("data", onData)
    client.on("error", () => client.destroy())
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    resolve({
      url: `http://127.0.0.1:${port}`,
      port,
      seen,
      // Open connections (a client's keep-alive pool) are cut, so closing never waits on them.
      close: () => new Promise((closed) => {
        server.close(() => closed())
        clients.forEach((client) => client.destroy())
      }),
    })
  }))
}

/**
 * Whether the machine running the tests has a proxy in its environment. Bun's
 * fetch applies one to every request without a `proxy` option, whatever a
 * test's `ConfigProvider` says, so the tests of direct requests skip then.
 */
export const ambientProxy: boolean = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"]
  .some((name) => (process.env[name] ?? "").trim().length > 0)

/** A port on 127.0.0.1 that nothing listens on (bound, then released). */
export const closedPort = (): Promise<number> => {
  const server = createServer()
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    server.close(() => resolve(port))
  }))
}
