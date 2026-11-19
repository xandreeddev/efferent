---
"@xandreed/sdk": minor
---

The kernel's workspace on a disk, a shell and a search, each a layer a host plugs in (ADR 0028): `diskFiles` and
`processShell` on `@xandreed/sdk/kernel/node`; the `Shell` and `Search` contracts with their kits, `scriptedShell`,
`filesSearch` and the tools `runCommand` and `searchFiles` on `@xandreed/sdk/kernel`. `recoverTurns` now gives a
`Recovery`, `{ closed, unreadable }`, passing over a session the store cannot read.
