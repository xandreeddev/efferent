---
name: gate-rule-authoring
description: How to write a custom deterministic gate rule (the plugged IdiomRule shape) for a workspace quality profile — patterns, the fail-closed contract, and worked examples.
---

# Authoring a custom gate rule

A rule is a PLAIN structural object in a TS module the workspace owns
(conventionally under `.efferent/gates/`). No efferent imports — the shape
is the contract:

```ts
import ts from "typescript"   // resolves against the workspace's own node_modules

export const noDefaultExport = {
  id: "local/no-default-export",          // "<namespace>/<name>" — use "local/" for project rules
  defaultSeverity: "error",                // "error" gates; "warning"/"info" are advisory
  description: "default exports are banned",
  fixHint: "use a named export — imports stay greppable and rename-safe",
  check: ({ sourceFile, checker }: { sourceFile: ts.SourceFile; checker: ts.TypeChecker }) => {
    const matches: Array<{ node: ts.Node; message: string }> = []
    const walk = (node: ts.Node): void => {
      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        matches.push({ node, message: "default export" })
      }
      node.forEachChild(walk)
    }
    walk(sourceFile)
    return matches
  },
}

export const rules = [noDefaultExport]     // the module's pluggable surface
```

The config module plugs them in:

```ts
import { rules } from "./.efferent/gates/index.ts"
export const customRules = rules
export default {
  tsconfig: "tsconfig.json",
  rules: [{ rule: "local/no-default-export", include: ["src/**"] }],
}
```

## The three patterns

1. **Text rules** (no compiler API): read `sourceFile.text` — regex or
   substring checks. Anchor the finding on `sourceFile` itself; the location
   lands on the first real statement. Right for banned markers, forbidden
   imports by string, file-shape conventions.
2. **AST rules** (syntax): walk with `node.forEachChild` and test node kinds
   (`ts.isCallExpression`, `ts.SyntaxKind.*`). Right for banned constructs,
   naming conventions, call-shape rules. This is the workhorse.
3. **Type-aware rules**: use `checker` (`getSignatureFromDeclaration`,
   `typeToString`, type flags) when syntax can't answer — e.g. "exported
   functions must not return `A | null`". Slower; reach for it only when
   needed.

## The contract (what the runner guarantees and expects)

- `check` returns an ARRAY of `{node, message}` — one entry per violation.
  Return `[]` for a clean file; never null/undefined.
- A rule that THROWS reports itself as a finding on the file it was checking
  (fail-closed) — but a crashing rule is noise on every file; test on a
  sample file before arming.
- Rules run on EVERY file the config's `include` globs select, on every
  gate run — keep per-file work linear; hoist regexes and Sets to module
  scope.
- Severity below "error" never gates a run — start at "error" and scope
  tightly with `include`/`exclude` rather than downgrading severity.
- Pre-existing violations are GRANDFATHERED by the baseline at profile lock;
  only NEW code must satisfy the rule. Write the message for the person
  seeing it on fresh code.

## Message and fixHint quality

The finding's `message` names WHAT is wrong in this instance; the `fixHint`
names the way OUT — both reach the coder verbatim as its retry brief. Bad:
"style violation". Good: "static mutable field — shared global state" with
fix "inject the dependency through the constructor".
