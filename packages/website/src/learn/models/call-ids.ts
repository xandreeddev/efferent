// The ids a browser model gives its tool calls. A provider's ids are unique;
// a model that runs in the page mints its own, and a counter alone starts
// again with every page load: a conversation kept in the browser's storage
// would then hold two calls with one id. So each minter numbers its calls
// after a few characters of its own, drawn when the page loads.

/** A few random characters: what tells one page load's calls from another's. */
const drawn = (): string => Math.random().toString(36).slice(2, 8).padEnd(6, "0")

/**
 * A minter of call ids: `<prefix>-<run>-<n>`, n counting from one. Two minters
 * give different ids unless they are given the same `run`, which only a test does.
 */
export const callIds = (prefix: string, run: string = drawn()): (() => string) => {
  let count = 0
  return () => `${prefix}-${run}-${++count}`
}
