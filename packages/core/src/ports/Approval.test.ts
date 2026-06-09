import { describe, expect, test } from "bun:test"
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
