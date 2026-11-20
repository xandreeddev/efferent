import { Match, Option, Result } from "effect"
import { CHECK_PATH, ETC_ALWAYS, ETC_NETWORK, HELPER_PATH, INNER_ENV, INNER_HOME, INNER_WORK, TOOL_BIN, TOOL_ROOT } from "./sandbox.entity.js"
import type { Bind, HostEntry, HostLayout, Limits, SandboxPlan, ToolBind } from "./sandbox.entity.js"

const bindArgs = (bind: Bind): ReadonlyArray<string> => [bind.writable ? "--bind" : "--ro-bind", bind.host, bind.inner]

const topArgs = (entry: HostEntry): ReadonlyArray<string> => Match.valueTags(entry, {
  Link: ({ path, target }) => ["--symlink", target, path],
  Folder: ({ path }) => ["--ro-bind", path, path],
})

/**
 * Close every descriptor but the three streams: a runtime that spawns without close-on-exec (Bun does) hands its open
 * files and sockets to `bwrap`, which passes them on.
 */
const CLOSE_FDS = `for fd in /proc/self/fd/*; do n=\${fd##*/}; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-"; done 2>/dev/null; true`

/**
 * The sandbox's own words for the command: the shell closes every descriptor but the three streams, sets the limits,
 * then runs the command as its first argument (`"$1"`), so the command is data to the outer shell and runs only inside
 * the sandbox; nothing is spliced into a line.
 */
export const limitedArgv = (command: string, limits: Limits): ReadonlyArray<string> => [
  "/bin/sh", "-c",
  [
    CLOSE_FDS,
    "ulimit -c 0",
    ...(limits.memoryBytes === undefined ? [] : [`ulimit -v ${Math.floor(limits.memoryBytes / 1024)}`]),
    `ulimit -f ${Math.floor(limits.fileBytes / 512)}`,
    `exec /bin/sh -c "$1"`,
  ].join(" && "),
  "sh", command,
]

/**
 * `bwrap`'s arguments for one command (the program itself left out): every namespace unshared (the network shared
 * back only when the plan says), the sandbox ended with its parent and in a session of its own, an empty environment
 * but `PATH` (fixed: `CHECK_PATH` for the repository's checks, `HELPER_PATH` for the bot's commands) and `HOME` (`INNER_HOME`, made in the fresh `/tmp`), `/usr` and the system's top folders read-only, the `/etc` files
 * the plan needs, a fresh `/proc`, `/dev` and `/tmp`, the toolchain read-only under `/opt/tool` with a link to each
 * program in `/opt/tool/bin`, the plan's binds, the work folder at `/work` (the only writable bind but the plan's),
 * then the command in `cwd` under the limits. Every path is an argument of its own: none is ever a shell's text.
 */
export const bwrapArgv = (layout: HostLayout, plan: SandboxPlan, cwd: string, command: string, limits: Limits): ReadonlyArray<string> => {
  const etc = plan.network ? [...ETC_ALWAYS, ...ETC_NETWORK] : [...ETC_ALWAYS]
  return [
    "--unshare-all",
    ...(plan.network ? ["--share-net"] : []),
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv", "PATH", plan.repoBins ? CHECK_PATH : HELPER_PATH,
    "--setenv", "HOME", INNER_HOME,
    ...INNER_ENV.flatMap(([name, value]) => ["--setenv", name, value]),
    "--ro-bind", "/usr", "/usr",
    ...layout.top.flatMap(topArgs),
    ...layout.etc.filter((file) => etc.some((wanted) => wanted === file.path)).flatMap((file) => ["--ro-bind", file.real, file.path]),
    "--proc", "/proc",
    "--dev", "/dev",
    ...(layout.tmpfsSize ? ["--size", String(limits.tmpBytes)] : []),
    "--tmpfs", "/tmp",
    "--dir", INNER_HOME,
    ...layout.tools.flatMap((tool) => [...tool.binds.flatMap(bindArgs), ...(tool.program === `${TOOL_BIN}/${tool.name}` ? [] : ["--symlink", tool.program, `${TOOL_BIN}/${tool.name}`])]),
    ...plan.binds.flatMap(bindArgs),
    "--bind", plan.workDir, INNER_WORK,
    "--chdir", cwd,
    "--",
    ...limitedArgv(command, limits),
  ]
}

/** The probe a host is checked with: every namespace unshared, `/usr` and the system's top folders, then `true`. */
export const probeArgv = (layout: HostLayout): ReadonlyArray<string> => [
  "--unshare-all", "--die-with-parent", "--clearenv", "--ro-bind", "/usr", "/usr", ...layout.top.flatMap(topArgs), "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/true",
]

/**
 * Where a command starts inside the sandbox: the work folder, a folder under it given relative to it, or a host path
 * under the work folder; any other is refused with the reason.
 */
export const innerCwdOf = (workDir: string, cwd: Option.Option<string>): Result.Result<string, string> => Option.match(cwd, {
  onNone: () => Result.succeed(INNER_WORK),
  onSome: (given) => {
    const relative = given === workDir ? "" : given.startsWith(`${workDir}/`) ? given.slice(workDir.length + 1) : given.startsWith("/") ? null : given
    if (relative === null) return Result.fail(`${given} is not in the sandbox's work folder`)
    const parts = relative.split("/").filter((part) => part.length > 0 && part !== ".")
    return parts.includes("..") ? Result.fail(`${given} leads out of the sandbox's work folder`) : Result.succeed([INNER_WORK, ...parts].join("/"))
  },
})

/** What the host has of a tool, found by its real path: the folders around it that make where it is bound. */
export interface ToolFound {
  readonly name: string
  /** The program's real path on the host. */
  readonly real: string
  /** For `node`: its installation folder, which holds `bin/node` and `lib/node_modules`. */
  readonly prefix: Option.Option<string>
  /** For a program inside a package (`<package>/bin/x.js`): the package's folder. */
  readonly packageRoot: Option.Option<string>
  /** For a shim that runs a program from a `.tools` folder beside it (pnpm's): that folder. */
  readonly toolsDir: Option.Option<string>
}

/** A home folder's path: a folder bound from one must be a package's own (`/node_modules/`) or pnpm's `.tools`. */
const IN_A_HOME = /^\/(home|root|Users)\//

/** Whether a folder may be bound read-only: one outside every home, or in one only a package's or a `.tools`. */
const bindableFolder = (path: string): boolean => !IN_A_HOME.test(path) || path.includes("/node_modules/") || path.endsWith("/.tools")

/**
 * How a tool is bound, the least it needs and never a folder that holds more: under `/usr` it is in the sandbox already
 * and only linked; `node` by its program file and npm's package (`lib/node_modules/npm`; npm and npx are links into
 * it), never its whole installation folder; a program inside a package by the package's folder; a shim with a `.tools`
 * folder beside it (pnpm's) by the two, in `/opt/tool/bin` itself; any other by its file alone. A folder in a home that
 * is not a package's or a `.tools` is refused, and the tool with it (none: the tool is not in the sandbox).
 */
export const toolBindOf = (found: ToolFound): ReadonlyArray<ToolBind> => {
  const inner = `${TOOL_ROOT}/${found.name}`
  const base = found.real.slice(found.real.lastIndexOf("/") + 1)
  if (found.real.startsWith("/usr/")) return [{ name: found.name, binds: [], program: found.real }]
  const folders = [...Option.toArray(Option.map(found.prefix, (prefix) => `${prefix}/lib/node_modules/npm`)), ...Option.toArray(found.packageRoot), ...Option.toArray(found.toolsDir)]
  if (!folders.every(bindableFolder)) return []
  return Option.match(found.prefix, {
    onSome: (prefix) => {
      const npm = `${inner}/lib/node_modules/npm`
      return [
        {
          name: found.name,
          binds: [{ host: found.real, inner: `${inner}/bin/${base}`, writable: false }, { host: `${prefix}/lib/node_modules/npm`, inner: npm, writable: false }],
          program: `${inner}/bin/${base}`,
        },
        { name: "npm", binds: [], program: `${npm}/bin/npm-cli.js` },
        { name: "npx", binds: [], program: `${npm}/bin/npx-cli.js` },
      ]
    },
    onNone: () => Option.match(found.packageRoot, {
      onSome: (root) => [{ name: found.name, binds: [{ host: root, inner, writable: false }], program: `${inner}${found.real.slice(root.length)}` }],
      onNone: () => Option.match(found.toolsDir, {
        // A shim finds its program beside the path it was run by, so it is bound in the links' folder itself.
        onSome: (tools) => [{
          name: found.name,
          binds: [{ host: found.real, inner: `${TOOL_BIN}/${found.name}`, writable: false }, { host: tools, inner: `${TOOL_BIN}/.tools`, writable: false }],
          program: `${TOOL_BIN}/${found.name}`,
        }],
        onNone: () => [{ name: found.name, binds: [{ host: found.real, inner: `${inner}/${base}`, writable: false }], program: `${inner}/${base}` }],
      }),
    }),
  })
}

/**
 * The end of a stream's bytes as text: the last `limit` bytes of `chunks`, started at a character (a UTF-8
 * continuation byte at the cut is left out with what was cut before it), decoded with U+FFFD for a byte that is no
 * UTF-8; and how many bytes were left out before it. As the kernel's process shell keeps a stream.
 */
export const tailOf = (chunks: ReadonlyArray<Uint8Array>, limit: number): { readonly text: string; readonly cut: number } => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total)
  chunks.reduce((at, chunk) => { bytes.set(chunk, at); return at + chunk.length }, 0)
  let start = Math.max(0, total - limit)
  if (start > 0) while (start < total && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
  return { text: new TextDecoder("utf-8").decode(bytes.subarray(start)), cut: start }
}

/** A stream's chunks with what is older than the last `limit` bytes dropped, whole chunks kept, and the bytes dropped. */
export const keptOf = (chunks: ReadonlyArray<Uint8Array>, limit: number): { readonly chunks: ReadonlyArray<Uint8Array>; readonly dropped: number } => {
  let held = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  let first = 0
  while (first < chunks.length - 1 && held - (chunks[first]?.length ?? 0) >= limit) {
    held -= chunks[first]?.length ?? 0
    first += 1
  }
  return { chunks: chunks.slice(first), dropped: chunks.slice(0, first).reduce((sum, chunk) => sum + chunk.length, 0) }
}
