import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { INNER_PATH } from "./sandbox.entity.js"
import type { HostLayout } from "./sandbox.entity.js"
import { bwrapArgv, innerCwdOf, limitedArgv, toolBindOf } from "./sandbox.entity.functions.js"

const layout: HostLayout = {
  bwrap: "/usr/bin/bwrap",
  top: [{ _tag: "Link", path: "/bin", target: "usr/bin" }, { _tag: "Folder", path: "/lib64" }],
  etc: [{ path: "/etc/ld.so.cache", real: "/etc/ld.so.cache" }, { path: "/etc/resolv.conf", real: "/run/resolve/stub.conf" }, { path: "/etc/ssl", real: "/etc/ssl" }],
  tools: [{ name: "bun", binds: [{ host: "/home/user/.bun/bin/bun", inner: "/opt/tool/bun/bun", writable: false }], program: "/opt/tool/bun/bun" }],
}

const limits = { memoryBytes: 8 * 1024 ** 3, fileBytes: 1024 ** 3 }

describe("bwrapArgv", () => {
  test("offline: every namespace unshared, an empty environment but PATH and HOME, the work folder the one writable bind, the command an argument", () => {
    expect(bwrapArgv(layout, { workDir: "/cache/clone", network: false, binds: [] }, "/work", "echo 'a'; b", limits)).toEqual([
      "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
      "--setenv", "PATH", INNER_PATH, "--setenv", "HOME", "/tmp/home",
      "--ro-bind", "/usr", "/usr",
      "--symlink", "usr/bin", "/bin", "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home",
      "--ro-bind", "/home/user/.bun/bin/bun", "/opt/tool/bun/bun", "--symlink", "/opt/tool/bun/bun", "/opt/tool/bin/bun",
      "--bind", "/cache/clone", "/work",
      "--chdir", "/work",
      "--", ...limitedArgv("echo 'a'; b", limits),
    ])
  })

  test("with the network: --share-net and the resolver's and certificates' files, a link bound at its target's content; the plan's binds before the work folder", () => {
    const argv = bwrapArgv(layout, { workDir: "/c", network: true, binds: [{ host: "/cache/pkg/bun", inner: "/cache", writable: true }] }, "/work/sub", "x", limits)
    expect(argv.slice(0, 2)).toEqual(["--unshare-all", "--share-net"])
    expect(argv.join(" ")).toContain("--ro-bind /run/resolve/stub.conf /etc/resolv.conf --ro-bind /etc/ssl /etc/ssl --proc")
    expect(argv.join(" ")).toContain("--bind /cache/pkg/bun /cache --bind /c /work --chdir /work/sub --")
  })

  test("the limits are set by the sandbox's shell, the command passed as $1 and never spliced; the address space only when given", () => {
    expect(limitedArgv("a\"; $(b)", limits)).toEqual(["/bin/sh", "-c", `ulimit -c 0 && ulimit -v ${8 * 1024 * 1024} && ulimit -f ${2 * 1024 * 1024} && exec /bin/sh -c "$1"`, "sh", "a\"; $(b)"])
    expect(limitedArgv("x", { fileBytes: 1024 })).toEqual(["/bin/sh", "-c", `ulimit -c 0 && ulimit -f 2 && exec /bin/sh -c "$1"`, "sh", "x"])
  })
})

describe("innerCwdOf", () => {
  test.each([
    [Option.none(), Result.succeed("/work")],
    [Option.some("/cache/clone"), Result.succeed("/work")],
    [Option.some("/cache/clone/pkg/a"), Result.succeed("/work/pkg/a")],
    [Option.some("pkg/./a/"), Result.succeed("/work/pkg/a")],
    [Option.some("/etc"), Result.fail("/etc is not in the sandbox's work folder")],
    [Option.some("/cache/clone-other"), Result.fail("/cache/clone-other is not in the sandbox's work folder")],
    [Option.some("pkg/../../x"), Result.fail("pkg/../../x leads out of the sandbox's work folder")],
  ] as const)("%p", (cwd, expected) => {
    expect(innerCwdOf("/cache/clone", cwd)).toEqual(expected)
  })
})

describe("toolBindOf", () => {
  const none = Option.none<string>()
  test("a tool under /usr is linked, not bound", () => {
    expect(toolBindOf({ name: "bun", real: "/usr/bin/bun", prefix: none, packageRoot: none, toolsDir: none })).toEqual([{ name: "bun", binds: [], program: "/usr/bin/bun" }])
  })

  test("node by its installation folder, npm and npx linked into it", () => {
    const prefix = "/home/user/.local/share/fnm/node-versions/v24/installation"
    expect(toolBindOf({ name: "node", real: `${prefix}/bin/node`, prefix: Option.some(prefix), packageRoot: none, toolsDir: none })).toEqual([
      { name: "node", binds: [{ host: prefix, inner: "/opt/tool/node", writable: false }], program: "/opt/tool/node/bin/node" },
      { name: "npm", binds: [], program: "/opt/tool/node/lib/node_modules/npm/bin/npm-cli.js" },
      { name: "npx", binds: [], program: "/opt/tool/node/lib/node_modules/npm/bin/npx-cli.js" },
    ])
  })

  test("a program in a package by the package; a shim by its file and the .tools beside it, never its folder", () => {
    expect(toolBindOf({ name: "yarn", real: "/opt/yarn/bin/yarn.js", prefix: none, packageRoot: Option.some("/opt/yarn"), toolsDir: none })).toEqual([
      { name: "yarn", binds: [{ host: "/opt/yarn", inner: "/opt/tool/yarn", writable: false }], program: "/opt/tool/yarn/bin/yarn.js" },
    ])
    expect(toolBindOf({ name: "pnpm", real: "/home/user/.local/share/pnpm/pnpm", prefix: none, packageRoot: none, toolsDir: Option.some("/home/user/.local/share/pnpm/.tools") })).toEqual([{
      name: "pnpm",
      binds: [{ host: "/home/user/.local/share/pnpm/pnpm", inner: "/opt/tool/bin/pnpm", writable: false }, { host: "/home/user/.local/share/pnpm/.tools", inner: "/opt/tool/bin/.tools", writable: false }],
      program: "/opt/tool/bin/pnpm",
    }])
    expect(toolBindOf({ name: "bun", real: "/home/user/.bun/bin/bun", prefix: none, packageRoot: none, toolsDir: none })).toEqual([
      { name: "bun", binds: [{ host: "/home/user/.bun/bin/bun", inner: "/opt/tool/bun/bun", writable: false }], program: "/opt/tool/bun/bun" },
    ])
  })
})
