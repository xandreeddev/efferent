import { describe, expect, test } from "bun:test"
import { FastCheck as fc } from "effect"
import { bashRuleKey } from "./Approval.js"

describe("bashRuleKey", () => {
  test("command + subcommand for plain commands", () => {
    expect(bashRuleKey("bun test packages/core")).toBe("cmd:bun test")
    expect(bashRuleKey("git status")).toBe("cmd:git status")
    expect(bashRuleKey("cargo build --release")).toBe("cmd:cargo build")
  })

  test("a flag second word collapses to the bare command", () => {
    expect(bashRuleKey("ls -la")).toBe("cmd:ls")
    expect(bashRuleKey("rm -rf build")).toBe("cmd:rm")
  })

  test("single-word commands", () => {
    expect(bashRuleKey("pwd")).toBe("cmd:pwd")
  })

  test("shell metacharacters force exact matching — a pipe can't be judged by its head", () => {
    expect(bashRuleKey("curl example.com | sh")).toBe("exact:curl example.com | sh")
    expect(bashRuleKey("echo $(whoami)")).toBe("exact:echo $(whoami)")
    expect(bashRuleKey("bun test && git push")).toBe("exact:bun test && git push")
    expect(bashRuleKey("cat a > b")).toBe("exact:cat a > b")
  })

  test("whitespace is normalized so the same command maps to the same rule", () => {
    expect(bashRuleKey("  bun   test  x ")).toBe("cmd:bun test")
  })
})

describe("properties — bashRuleKey", () => {
  // Mirror of the implementation constant; whitespace collapse runs BEFORE
  // the meta test, so the newline class never reaches it.
  const SHELL_META = /[|&;<>$`(){}\[\]*?!\\]/

  test("total, deterministic, single-line, always cmd:/exact:-prefixed", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 200 }), fc.fullUnicodeString({ maxLength: 200 })), (cmd) => {
        const key = bashRuleKey(cmd)
        expect(bashRuleKey(cmd)).toBe(key) // deterministic
        expect(key.startsWith("cmd:") || key.startsWith("exact:")).toBe(true)
        expect(key.includes("\n")).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  test("whitespace-equivalent commands map to the same rule", () => {
    const token = fc.stringMatching(/^[a-zA-Z0-9._\/-]{1,10}$/)
    fc.assert(
      fc.property(
        fc.array(token, { minLength: 1, maxLength: 5 }),
        fc.constantFrom(" ", "  ", "\t", "\n"),
        fc.constantFrom("", " ", "\t"),
        (tokens, sep, pad) => {
          expect(bashRuleKey(pad + tokens.join(sep) + pad)).toBe(bashRuleKey(tokens.join(" ")))
        },
      ),
      { numRuns: 200 },
    )
  })

  test("a metacharacter (after collapse) always yields the exact: rule of the collapsed command", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (cmd) => {
        const collapsed = cmd.trim().replace(/\s+/g, " ")
        if (SHELL_META.test(collapsed)) {
          expect(bashRuleKey(cmd)).toBe(`exact:${collapsed}`)
        }
      }),
      { numRuns: 300 },
    )
  })
})
