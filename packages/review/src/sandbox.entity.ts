import { Schema } from "effect"

/**
 * No sandbox can be made on this host: `bwrap` is not installed, or the system does not let this user make the
 * namespaces it needs (unprivileged user namespaces off, or AppArmor restricting them), said in `reason`. Nothing of
 * the pull request's runs: there is never a fallback to a run outside a sandbox.
 */
export class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()("SandboxUnavailable", {
  reason: Schema.String,
  message: Schema.String,
}) {}

/** Where the work folder is inside the sandbox: its one writable folder but the tmpfs `/tmp`. */
export const INNER_WORK = "/work"

/**
 * The sandbox's `HOME`: in its own `/tmp`, a tmpfs gone when the command ends, so what a tool caches under the home
 * (bun's transpiler cache, npm's logs) never lands in the clone, where it would dirty the tree a check reads.
 */
export const INNER_HOME = "/tmp/home"

/** Where the toolchain is bound inside the sandbox, read-only, each tool under its name. */
export const TOOL_ROOT = "/opt/tool"

/** The folder of links to each tool, first on the sandbox's `PATH`. */
export const TOOL_BIN = `${TOOL_ROOT}/bin`

/**
 * The sandbox's `PATH`, fixed: the work folder's `node_modules/.bin`, the toolchain's links, then the system's. The
 * host's `PATH` is never passed: it names folders in a person's home.
 */
export const INNER_PATH = `${INNER_WORK}/node_modules/.bin:${TOOL_BIN}:/usr/local/bin:/usr/bin:/bin`

/**
 * The variables every sandbox sets besides `PATH` and `HOME`: pnpm runs as the host has it and never fetches the
 * version a repository's `packageManager` names (offline it cannot, and every pnpm command would fail).
 */
export const INNER_ENV: ReadonlyArray<readonly [string, string]> = [["npm_config_manage_package_manager_versions", "false"]]

/**
 * The top-level system folders a toolchain needs, as the host has them: a link (merged `/usr`: `/bin` to `usr/bin`) is
 * made again as a link, a folder is bound read-only, a missing one is left out.
 */
export const SYSTEM_TOP = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"] as const

/**
 * The files of `/etc` a sandbox with the network shares needs read-only, each bound only when the host has it: name
 * resolution and the certificates an install fetches over TLS. Never the whole of `/etc`. Without the network none is
 * bound but the dynamic linker's cache and the alternatives a system's tools are linked through.
 */
export const ETC_ALWAYS = ["/etc/ld.so.cache", "/etc/alternatives"] as const
export const ETC_NETWORK = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/host.conf", "/etc/gai.conf", "/etc/ssl", "/etc/ca-certificates", "/etc/pki"] as const

/** A top-level system path as the host has it. */
export const HostEntry = Schema.Union([
  Schema.TaggedStruct("Link", { path: Schema.String, target: Schema.String }),
  Schema.TaggedStruct("Folder", { path: Schema.String }),
])
export type HostEntry = typeof HostEntry.Type

/** A host path bound into the sandbox at `inner`, read-only unless `writable`. */
export const Bind = Schema.Struct({
  host: Schema.String,
  inner: Schema.String,
  writable: Schema.Boolean,
})
export type Bind = typeof Bind.Type

/** A tool as the sandbox sees it: the host paths bound for it read-only, and the link `/opt/tool/bin/<name>` to its program. */
export const ToolBind = Schema.Struct({
  name: Schema.String,
  binds: Schema.Array(Bind),
  program: Schema.String,
})
export type ToolBind = typeof ToolBind.Type

/**
 * The host's side of every sandbox: `bwrap`'s absolute path, the system's top folders and the `/etc` files there are
 * (each a real path, a link in `/etc` bound at its target's content), and the toolchain.
 */
export const HostLayout = Schema.Struct({
  bwrap: Schema.String,
  /** Whether this `bwrap` bounds a tmpfs (`--size`, bubblewrap 0.10 and later). */
  tmpfsSize: Schema.Boolean,
  top: Schema.Array(HostEntry),
  etc: Schema.Array(Schema.Struct({ path: Schema.String, real: Schema.String })),
  tools: Schema.Array(ToolBind),
})
export type HostLayout = typeof HostLayout.Type

/**
 * One sandbox: its work folder on the host (bound at `/work`, the one writable bind besides `binds` that say so),
 * whether it shares the host's network, and the further binds (a package cache, a snapshot).
 */
export const SandboxPlan = Schema.Struct({
  workDir: Schema.String,
  network: Schema.Boolean,
  binds: Schema.Array(Bind),
})
export type SandboxPlan = typeof SandboxPlan.Type

/**
 * The bounds a command runs under inside the sandbox: the size of its `/tmp`, a tmpfs held in memory (`--size`, where
 * the host's bwrap has it), and, set with the shell's `ulimit` before it starts, the largest file it may write, in
 * bytes, and, when given, its address space; no core files. The address space is no memory bound for
 * the JavaScript runtimes: bun reserves far more than it uses (its type check dies under 8 GiB), so it is off unless a
 * host sets it; bounding memory needs a cgroup.
 */
export const Limits = Schema.Struct({
  memoryBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  fileBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  tmpBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type Limits = typeof Limits.Type

/** The defaults: 5 minutes a command, 2 GiB a file, 2 GiB of `/tmp`, no bound on the address space, 4 MiB of each stream. */
export const SANDBOX_DEFAULTS = {
  timeoutMs: 300_000,
  limits: { fileBytes: 2 * 1024 ** 3, tmpBytes: 2 * 1024 ** 3 },
  outputBytes: 4 * 1024 * 1024,
} as const
