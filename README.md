# Efferent

**Compose the agent. Own the harness.**

An Effect-native agent framework for Node 24 and Bun: a small kernel (a
journal, sessions and events) with every other part a plain Effect layer
you can replace: memory, model providers that charge a spend ledger, tools,
approvals, skills, background tasks, a workspace, knowledge kept by a curator
and recalled by words and meaning, and telemetry. There is no loop to
configure: your program is the loop.

**[Documentation](https://xandreeddev.github.io/efferent/docs/)** · [Learn](https://xandreeddev.github.io/efferent/learn/) · [The kernel guide](docs/kernel.md) · [Changelog](CHANGELOG.md)

## Install

```sh
npm install effect @xandreed/core @xandreed/sdk
```

`effect` (4.x) and `@xandreed/core` are peer dependencies: your code and the
packages share one copy of each.
Workspace packages share version `0.22.0`.

Until the next release moves it to the package roots, the kernel is imported
from `@xandreed/core/kernel`, `@xandreed/sdk/kernel` and, for the ports that
need Node or Bun (durable journals, model providers, a disk workspace and a
shell, OTLP export), `@xandreed/sdk/kernel/node`.

## Learn more

- [Learn](https://xandreeddev.github.io/efferent/learn/): build an agent on the kernel, step by step, in your browser
- [The kernel](docs/kernel.md): how a host writes its turn, the contracts and stock plugins, and why each is shaped as it is
- [The decisions](docs/adr/): one record per architectural decision
- [Evaluations](https://xandreeddev.github.io/efferent/docs/concepts/evals/): tasks, trials, graders and suites

## Packages

| Package | What it is |
| --- | --- |
| `@xandreed/core` | The kernel's core: the journal, sessions, events and the spend ledger, with their conformance kits |
| `@xandreed/sdk` | The workflow contracts and stock plugins, and the Node entry's ports |
| `@xandreed/evals`, `@xandreed/evals-cli`, `@xandreed/evals-langfuse`, `@xandreed/evals-langsmith` | Evaluations, their CLI and exporters |

The engine of earlier releases (`@xandreed/runtime`, `@xandreed/process-host`
and the `@xandreed/plugin-*` packages) is no longer published: those
packages stay on npm at 0.22.0, and the [changelog](CHANGELOG.md) lists what
replaces each.

## Contributing

```sh
bun install
bun run verify
```

See [contributing](CONTRIBUTING.md) for the full checks and how releases work.

MIT · Xand Reed
