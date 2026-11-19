---
title: Getting started
description: Build an agent on the Efferent kernel, with the guide and the learn track.
---

# Efferent

**Compose the agent. Own the harness.**

An Effect-native agent framework for Node 24 and Bun: a small kernel (a
journal, sessions and events) and every other part a plain Effect layer you
can replace, memory, model providers, tools, approvals, skills, tasks,
knowledge and telemetry among them.

## Install

```sh
npm install effect @xandreed/core @xandreed/sdk
```

Install `effect` (4.0.7 or a later 4.x) and `@xandreed/core` beside the sdk:
the packages and your code share one copy of each.

This guide follows version `0.22.0`. The next release publishes the kernel at
the package roots; until then it is imported from `@xandreed/core/kernel`,
`@xandreed/sdk/kernel` and, for the ports that need Node or Bun,
`@xandreed/sdk/kernel/node`.

## Where to go next

- **The guide** is [`docs/kernel.md`](https://github.com/xandreeddev/efferent/blob/main/docs/kernel.md):
  how a host writes its turn, which parts it composes, and why each is shaped
  as it is. Its examples are tests that run.
- **The tutorial** is the [learn track](/learn/): a working agent built one
  lesson at a time, in your browser.
- **The decisions** are the [ADRs](https://github.com/xandreeddev/efferent/tree/main/docs/adr).

The engine of earlier releases (`Agent.define`, the runtime, the process host
and the `@xandreed/plugin-*` packages) is gone: those packages stay on npm at
0.22.0 and are not published again. The changelog lists what replaces each.
