import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { bashExitOf, errorCodeOf, executableCandidates, fsReasonOf, isClosedInput, pathIn, removalPlace } from "./local-system.entity.functions.js"

const coded = (code: string) => Object.assign(new Error(`${code}: something`), { code })

describe("node error codes as file-system reasons", () => {
  test("each code the port distinguishes maps to its reason, Node's own included", () => {
    const codes = ["ENOENT", "EEXIST", "EISDIR", "ERR_FS_EISDIR", "ENOTDIR", "ENOTEMPTY", "EACCES", "EPERM", "EINVAL", "ELOOP", "ENAMETOOLONG", "ERR_INVALID_ARG_VALUE"]
    expect(codes.map((code) => fsReasonOf(coded(code)))).toEqual([
      "NotFound", "Exists", "IsDirectory", "IsDirectory", "NotDirectory", "NotEmpty", "Permission", "Permission", "Invalid", "Invalid", "Invalid", "Invalid",
    ])
  })

  test("any other code, an error without one, and a thrown non-error are Io", () => {
    expect([coded("EIO"), coded("EMFILE"), coded("toString"), new Error("no code"), "a string", null, { code: 5 }].map(fsReasonOf))
      .toEqual(["Io", "Io", "Io", "Io", "Io", "Io", "Io"])
  })

  test("errorCodeOf reads a string code only", () => {
    expect([coded("ENOENT"), { code: "EPIPE" }, { code: 32 }, undefined].map(errorCodeOf)).toEqual([Option.some("ENOENT"), Option.some("EPIPE"), Option.none(), Option.none()])
  })
})

describe("a command's closed input", () => {
  test("EPIPE and ERR_STREAM_DESTROYED mean the command stopped reading; other errors do not", () => {
    expect([coded("EPIPE"), coded("ERR_STREAM_DESTROYED"), coded("EBADF"), new Error("plain"), "EPIPE"].map(isClosedInput)).toEqual([true, true, false, false, false])
  })
})

describe("finding the shell", () => {
  test("a name is tried in each absolute PATH directory in order; an absolute path is itself; relative entries and names are skipped", () => {
    expect(executableCandidates("bash", Option.some("/usr/local/bin:relative/bin::/bin/"))).toEqual(["/usr/local/bin/bash", "/bin/bash"])
    expect(executableCandidates("/opt/shell", Option.some("/bin"))).toEqual(["/opt/shell"])
    expect(executableCandidates("bin/bash", Option.some("/usr"))).toEqual([])
    expect(executableCandidates("bash", Option.none())).toEqual([])
    expect(executableCandidates("", Option.some("/bin"))).toEqual([])
  })
})

describe("where remove acts", () => {
  const placeOf = (path: string) => Result.match(removalPlace(path), { onFailure: (message) => `refused: ${message}`, onSuccess: ({ parent, name }) => `${parent} ${name}` })

  test("the parent as written and the last name, trailing slashes ignored", () => {
    expect(["/tmp/a", "/tmp/link/", "/tmp//a//", "/a", "/l/../b", "/a/./b", "/..a"].map(placeOf))
      .toEqual(["/tmp a", "/tmp link", "/tmp a", "/ a", "/l/.. b", "/a/. b", "/ ..a"])
  })

  test("never the root, a path ending in . or .., or a relative path", () => {
    expect(["/", "//", "/.", "/tmp/..", "/tmp/link/..", "/tmp/a/./", "relative", ""].map(placeOf)).toEqual([
      "refused: the root directory is never removed",
      "refused: the root directory is never removed",
      "refused: a path whose last segment is . is never removed: /.",
      "refused: a path whose last segment is .. is never removed: /tmp/..",
      "refused: a path whose last segment is .. is never removed: /tmp/link/..",
      "refused: a path whose last segment is . is never removed: /tmp/a/./",
      "refused: paths must be absolute: relative",
      "refused: paths must be absolute: ",
    ])
  })

  test("a name in a resolved directory, the root included", () => {
    expect([pathIn("/", "a"), pathIn("/tmp", "a"), pathIn("/tmp/", "a")]).toEqual(["/a", "/tmp/a", "/tmp/a"])
  })
})

describe("a process's end", () => {
  const end = (code: number | null, signal: string | null, timedOut: boolean) => {
    const exit = bashExitOf({ code, signal, timedOut, durationMs: 7 })
    return [exit.termination, Option.getOrNull(exit.exitCode), Option.getOrNull(exit.signal), exit.durationMs]
  }

  test("an exit keeps its code, a signal its name, and a timeout kill is a timeout", () => {
    expect(end(3, null, false)).toEqual(["exit", 3, null, 7])
    expect(end(null, "SIGTERM", false)).toEqual(["signal", null, "SIGTERM", 7])
    expect(end(null, "SIGKILL", true)).toEqual(["timeout", null, "SIGKILL", 7])
  })

  test("a command that exited on its own as its timeout came is an exit", () => {
    expect(end(0, null, true)).toEqual(["exit", 0, null, 7])
  })
})
