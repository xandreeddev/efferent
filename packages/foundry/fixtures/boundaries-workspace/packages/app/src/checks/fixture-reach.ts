// The "app-tests" layer: it may reach a testing module no `exports` lists.
// (A real test file would be `*.test.ts`; `bun test` must not run this one.)
import { fixture } from "@fixture/base/testing/fixture.testing"

export const reach = fixture
