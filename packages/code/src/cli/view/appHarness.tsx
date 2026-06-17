import { App } from "./App.js"
import type { TuiContext } from "../state/store.js"

/**
 * Test harness: wraps <App> in a zero-arg render thunk for `testRender`. Kept in
 * a `.tsx` so the JSX lives in an imported module (Bun's runtime plugin only
 * transforms imported `.tsx`, never the `.test.ts` entrypoint).
 */
export const makeApp = (ctx: TuiContext) => () => <App ctx={ctx} />
