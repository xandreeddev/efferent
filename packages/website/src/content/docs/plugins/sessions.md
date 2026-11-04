---
title: Sessions and turn ownership
description: Manage durable conversations, serialized turns, inboxes and forks over a chosen session log.
pluginId: "@xandreed/plugin-sessions"
---

`sessionsPlugin` implements `Sessions` above a storage backend. It coordinates
one open turn per session, the durable inbox, forks and resumes, plus the
activity and shutdown signals the host uses to manage its process.

## When to use it

Use sessions whenever a conversation needs durable turn boundaries or can
receive work while another turn is running. Select a `SessionLog` backend
separately: [files](/docs/plugins/session-files/) supports Node and Bun;
[SQLite](/docs/plugins/session-sqlite/) supports Bun.

`TurnAdmission` is also required. Combined storage plugins provide open
admission; their log-only variants let a host supply its own policy.

## Install and configure

```sh
npm install effect @xandreed/plugin-sessions @xandreed/plugin-session-files
```

```ts
import { sessionFilesPlugin } from "@xandreed/plugin-session-files"
import { sessionsPlugin } from "@xandreed/plugin-sessions"

const plugins = [
  sessionFilesPlugin,
  {
    plugin: sessionsPlugin,
    options: {
      ownership: {
        mode: "lease",
        ttlMs: 120_000,
        renew: { everyMs: 30_000 },
      },
      turns: { timeLimitMs: 900_000 },
    },
  },
]
```

These are entries for `Agent.define`'s `plugins` array. Add your conversation
memory, registry, step loop and model configuration to complete the graph.
The example overrides ownership and the turn time limit; other options keep
their defaults. A host can instead build `SessionsPluginLive` as a scoped
layer and pass its `Sessions` service to turns.

## Ownership and time limits

Lease ownership is the default: 60 seconds, renewed by writes and a keep-alive
every 20 seconds. For a custom lease, `renew.everyMs` must be at most half of
`ttlMs`. Renewals follow the writer's queue, so keep individual writes and
transactions shorter than the lease.

Process ownership (`ownership: { mode: "process" }`) holds a turn while its
local holder process lives. A holder on another host cannot be checked and
remains held; use leases when hosts share a log. The turn time limit is
separate from ownership and interrupts a turn that runs too long.

Busy sessions refuse a second begin. Queue user input explicitly rather
than replacing the active turn. Treat takeover as host authority after
establishing that the previous holder is gone, not a routine retry option.

## Inbox, forks and context

Enqueued user input survives failed or partial attempts. Inbox notices have
their own bounded attempt policy. `Sessions.drain` can select inputs,
notices or both; background task reactions select notices so they do not
consume the host's queued user work.

Forks retain a sequence boundary into their ancestors. Reading a child
includes eligible ancestor history through that boundary and its own new
records. Later parent activity does not appear in the fork.
The journal remains distinct from the bounded context rendered for a model;
see [context, memory and the journal](/docs/concepts/context-journal/).

## Host lifecycle

`TurnActivity` tracks turns this instance is beginning or holds open.
`TurnShutdown` rejects new begins and closes held turns during graceful
shutdown. `WaitingInput` reports owner-observed queued user input; it is a
signal for the host, not an automatic input executor.

For automatic draining, the package separately exports `InboxDrainLive`.
The host supplies its owners and `InboxRunner`, and explicitly decides any
startup takeover authority. Keep that worker and the agent in an appropriate
Effect scope. Existing journal data remains in the selected backend.

## Related guides

- [File-backed sessions](/docs/plugins/session-files/)
- [Background tasks](/docs/plugins/tasks/)
- [SDK and sessions](/docs/concepts/harness/)
- [Context, memory and the journal](/docs/concepts/context-journal/)

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-sessions` · Version **0.16.2** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/Sessions`, `efferent/TurnActivity`, `@xandreed/core/TurnShutdown`, `@xandreed/core/WaitingInput` |
| Requires | `efferent/SessionLog`, `efferent/TurnAdmission` |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "ownership": {
    "mode": "lease",
    "ttlMs": 60000,
    "renew": {
      "everyMs": 20000
    }
  },
  "titleChars": 80,
  "inbox": {
    "maxPending": 20,
    "attempts": 2,
    "pollIntervalMs": 100,
    "recentSessions": 256
  },
  "writer": {
    "capacity": 1024,
    "batch": 64
  },
  "retries": 8,
  "turns": {
    "timeLimitMs": 21600000
  }
}
```

### Options schema

<details>
<summary>Show the full configuration schema</summary>

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "ownership": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "lease"
              ]
            },
            "ttlMs": {
              "type": "integer",
              "minimum": 1000,
              "maximum": 9007199254740991
            },
            "renew": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "none",
                    "on-commit"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "everyMs": {
                      "type": "integer",
                      "minimum": 100,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "everyMs"
                  ],
                  "additionalProperties": true
                }
              ]
            }
          },
          "required": [
            "mode",
            "ttlMs",
            "renew"
          ],
          "additionalProperties": true,
          "description": "A turn is held for ttlMs (storage time) after its begin and after each renewal. renew: \"none\" fixes the lease at begin, \"on-commit\" extends it with each write, { everyMs } also extends it with a keep-alive every everyMs while the turn is open (the first one interval after the begin). everyMs must be at most half of ttlMs (everyMs * 2 <= ttlMs), or the options fail with config.options."
        },
        {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "process"
              ]
            }
          },
          "required": [
            "mode"
          ],
          "additionalProperties": true
        }
      ]
    },
    "titleChars": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    },
    "inbox": {
      "type": "object",
      "properties": {
        "maxPending": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000
        },
        "pollIntervalMs": {
          "type": "integer",
          "minimum": 1,
          "maximum": 60000
        },
        "recentSessions": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100000
        },
        "attempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        }
      },
      "required": [
        "maxPending",
        "recentSessions",
        "attempts"
      ],
      "additionalProperties": true
    },
    "writer": {
      "type": "object",
      "properties": {
        "capacity": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100000
        },
        "batch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10000
        }
      },
      "required": [
        "capacity",
        "batch"
      ],
      "additionalProperties": true
    },
    "retries": {
      "type": "integer",
      "minimum": 1,
      "maximum": 64
    },
    "turns": {
      "type": "object",
      "properties": {
        "timeLimitMs": {
          "type": "integer",
          "minimum": 1,
          "maximum": 604800000
        }
      },
      "required": [
        "timeLimitMs"
      ],
      "additionalProperties": true
    }
  },
  "required": [
    "ownership",
    "titleChars",
    "inbox",
    "writer",
    "retries",
    "turns"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
