/** Tiny component used by smoke.test.ts to prove the JSX transform + native render path. */
export const SmokeApp = () => (
  <box border title="smoke" padding={1}>
    <text>hello opentui</text>
  </box>
)
