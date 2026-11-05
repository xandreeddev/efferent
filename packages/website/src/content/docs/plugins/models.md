---
title: Models
description: Route conversation and helper calls, configure endpoints, and supply credentials.
pluginId: "@xandreed/plugin-models"
---

The models plugin supplies the main `LanguageModel`, the helper `UtilityLlm`,
credential and settings stores, and a model catalog. Use it to select a
built-in provider or a compatible local server or gateway.

The main model runs the conversation. The utility model supports work such as
conversation summaries, result digests, memory extraction and evidence review.
Neither service is an embedding model.

## Install

```sh
npm install @xandreed/plugin-models
```

Install `effect`, `@xandreed/core` and `@xandreed/sdk` with your agent's other
plugins. This package runs on Node 24.5 or newer and Bun.

## Add to an agent

This configuration fragment selects an OpenAI-compatible local endpoint:

```ts
import { modelsPlugin } from "@xandreed/plugin-models"

const plugins = [
  { plugin: modelsPlugin, options: {
    model: "local:llama3.1:8b",
    fastModel: "local:llama3.1:8b",
    storage: "memory",
    endpoints: { local: { url: "http://localhost:11434/v1" } },
  } },
]
```

Pass these entries in `Agent.define({ plugins })` alongside the loop,
discovery and conversation-memory plugins. The graph also needs
`SessionEnvironment`, normally supplied by a workspace plugin. The server
must already be running; the example does not start or download a model.

## Model selection and credentials

Selections use `provider:modelId`. `model` chooses conversation calls,
`fastModel` chooses helper calls, and `fallbackModel` configures a fallback.
Empty selections leave existing settings in effect; configure them explicitly
when the host needs predictable model choices.

Compatible endpoints accept `apiKeyEnv` for a secret read through Effect's
`ConfigProvider`. An endpoint with no configured or stored key sends no
authorization header. Built-in providers use the credential store. Keep keys
outside source code; see [provider configuration](/docs/concepts/providers/)
for endpoint protocols, key precedence and per-model settings.

`storage: "memory"` keeps settings and credentials in process memory. It can
read API keys from `credentialEnv` or accept the optional host-owned
`HostCredentials` service. `storage: "local"`, the default, uses Efferent's
local credential files and can inherit earlier sign-ins and settings.
Inline `credentials`, `credentialEnv`, and `HostCredentials` require memory
storage. Restart behavior therefore depends on the selected storage mode.

## Composition and limits

This is a runtime-scoped provider. Each turn's helper calls still use that
turn's usage recorder and budgets. The plugin does not supply an agent loop,
session journal, conversation-memory policy, PostgreSQL database, or
`EmbeddingModel.EmbeddingModel`.

Native [memory](/docs/plugins/memory/) and [RAG](/docs/plugins/rag/) require a
separate host-supplied embedding service whose model identity and dimensions
match their configuration. Selecting `fastModel` does not meet that dependency.

Use [summary memory](/docs/plugins/memory-summary/) for conversation summaries
and [result digests](/docs/plugins/memory-digest/) for supported tool results.
The [context and journal guide](/docs/concepts/context-journal/) explains where
their helper outputs are recorded and how later requests use them.

## Test without a key

`@xandreed/plugin-models/testing` exports `scriptedChatCompletions`, an
OpenAI-compatible chat-completions endpoint that answers from a script in
the process. Give its `fetch` to the plugin as the host's `ModelsTransport`
(or to a compat client as `fetchImpl`): the production client, its retries
and its usage accounting run, with no key and no network.

```ts
import { Context, Effect } from "effect"
import { modelsPlugin, ModelsTransport } from "@xandreed/plugin-models"
import { scriptedChatCompletions } from "@xandreed/plugin-models/testing"
import type { ScriptedRequest } from "@xandreed/plugin-models/testing"

const sawResult = (request: ScriptedRequest) => JSON.stringify(request.body["messages"] ?? []).includes("FOUND")
const endpoint = scriptedChatCompletions([
  {
    toolCalls: [{ name: "lookup", arguments: JSON.stringify({ query: "alpha" }) }],
    usage: { promptTokens: 40, completionTokens: 9 },
    when: (request) => !sawResult(request),
  },
  { text: "Found alpha.", when: sawResult },
])

const plugins = [
  { plugin: modelsPlugin, options: {
    model: "scripted:m",
    storage: "memory",
    endpoints: { scripted: { url: "https://scripted.invalid/v1" } },
  } },
]
const services = Context.make(ModelsTransport, ModelsTransport.of({ fetch: endpoint.fetch }))
// Agent.define({ plugins, services, ... }), run a turn, then:
const seen = Effect.runSync(endpoint.requests)
```

A request takes the first step, in script order, that is still available
and whose `when` accepts it; a step without `when` takes the next request,
and a `repeat` step keeps answering. A streamed request gets the reply as
`data:` chunks, one per read: the text and each tool call's arguments in
fragments of `chunkSize` characters (default 8; give an array to choose the
fragments), the usage on the final chunk, then `[DONE]`. A settled request
gets the whole reply in one body. A step without `usage` reports none, which
the plugin records as unknown, not zero. `beforeChunk` runs before each chunk
is sent, to hold or slow a stream. A request no step answers is refused with
HTTP 400 and an error naming it and the steps left, so the call fails at once
instead of being retried. `requests` lists every request with the step that
answered it, and `remaining` the steps no request has used. A script can be
kept as JSON and decoded with the `ScriptedReply` schema.

## Spend caps

The `spend` option caps what model calls may cost, per turn and in all. It
guards every physical send the plugin makes (a first attempt, a retry, a
fallback's, a helper call) through a `ModelSpend` ledger the host passes in
the agent's `services`:

```ts
import { Context } from "effect"
import { ModelSpend, ModelSpendMemoryLive } from "@xandreed/core"
import { modelsPlugin } from "@xandreed/plugin-models"

declare const ledger: ModelSpend["Service"] // built once from ModelSpendMemoryLive

const agentConfig = {
  plugins: [
    { plugin: modelsPlugin, options: {
      model: "anthropic:claude-sonnet-4-5",
      spend: {
        prices: { "anthropic:claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
        turnCap: 0.5,
        totalCap: 20,
      },
    } },
  ],
  services: Context.make(ModelSpend, ledger),
}
```

Before a send goes out, the plugin reserves its worst case: the request
body's bytes as input tokens (`inputBytesPerToken`, 1 by default) at the
dearest input price, and the request's output cap (else
`uncappedOutputTokens`, 32 000 by default) at the dearest output price. When
the attempt ends it settles at what its reported usage cost (`costOf`).
Without a final usage report, a request that went out settles at its worst
case, whether it completed, failed or was cut off: a timeout, a connection
lost after the send, a gateway's timeout status (408, 504, 524) or a stream
cut before its usage may all have been generated and billed. A request the
provider refused with another error status, or one that never went out (a
connection that never opened, an interruption before the send), releases
its hold.

A send whose worst case would take the turn's or the ledger's settled and
held spend past `turnCap` or `totalCap` is not sent: the turn fails with a
`HarnessError` of code `model.spend`, whose cause `modelSpendExceededOf`
returns (which cap, its amount, what was committed and what was asked). A
model missing from `prices` is refused with `model.unpriced`. `TurnResult.spend`
reports the turn's settled spend, and `ledger.totals` reads the whole
ledger's, or a turn's while it runs: as a turn's scope closes, the turn
calls `ledger.forget`, which drops what the ledger keeps for that turn
alone (its total keeps the spend), so a ledger that lives as long as its
process does not grow with every turn. One ledger is one run of spend:
build it once per process or evaluation run and share it between agents
that share its caps. The
`spend` option without a ledger fails when the agent is defined. A host's
own ledger, such as a shared store, implements the `ModelSpend` port and is
checked with `modelSpendConformance` from `@xandreed/core/conformance`. The
plugin reserves uninterruptibly, so a hold the ledger has taken always
reaches the attempt that closes it: such a ledger bounds its own wait on
the store and fails with `ModelSpendUnavailable` past it.
In an evaluation run, `@xandreed/evals` builds that ledger and gives each
trial's runnable its account in it as `ModelSpend`; pass it to the agent the
trial defines, and `efferent-eval run --budget-usd` caps the whole run
([spend budget](/docs/concepts/evals/#spend-budget)).

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-models` · Version **0.17.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `effect/ai/LanguageModel`, `@xandreed/core/UtilityLlm`, `@xandreed/core/AuthStore`, `@xandreed/core/SettingsStore`, `@xandreed/core/ModelCatalog` |
| Requires | `efferent/SessionEnvironment` |
| Uses when available | `@xandreed/plugin-models/HostCredentials`, `@xandreed/plugin-models/ModelsTransport`, `@xandreed/core/ModelSpend` |
| Contributes | none |

### Default options

```json
{
  "model": "",
  "fastModel": "",
  "fallbackModel": "",
  "inheritPrevious": true,
  "endpoints": {},
  "modelSettings": {},
  "storage": "local",
  "credentials": {},
  "credentialEnv": {},
  "proxy": "",
  "noProxy": "",
  "thinkingPrefixMismatch": "drop_block"
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
    "model": {
      "type": "string"
    },
    "fastModel": {
      "type": "string"
    },
    "fallbackModel": {
      "type": "string"
    },
    "inheritPrevious": {
      "type": "boolean"
    },
    "endpoints": {
      "type": "object",
      "additionalProperties": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "url": {
                "type": "string"
              },
              "apiKey": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "string"
                  }
                ]
              },
              "apiKeyEnv": {
                "type": "string"
              },
              "images": {
                "type": "boolean"
              },
              "api": {
                "type": "string",
                "enum": [
                  "chat-completions"
                ]
              },
              "standardOnly": {
                "type": "boolean"
              }
            },
            "required": [
              "url"
            ],
            "additionalProperties": true
          },
          {
            "type": "object",
            "properties": {
              "url": {
                "type": "string"
              },
              "apiKey": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "string"
                  }
                ]
              },
              "apiKeyEnv": {
                "type": "string"
              },
              "images": {
                "type": "boolean"
              },
              "api": {
                "type": "string",
                "enum": [
                  "anthropic-messages"
                ]
              },
              "auth": {
                "type": "string",
                "enum": [
                  "x-api-key",
                  "bearer"
                ]
              },
              "cacheControl": {
                "type": "boolean"
              },
              "apiVersion": {
                "type": "string"
              },
              "betas": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "url",
              "api"
            ],
            "additionalProperties": true
          }
        ]
      }
    },
    "modelSettings": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "thinking": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "Adaptive"
                    ]
                  },
                  "display": {
                    "type": "string",
                    "enum": [
                      "summarized",
                      "omitted"
                    ]
                  }
                },
                "required": [
                  "_tag"
                ],
                "additionalProperties": true
              },
              {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "Budget"
                    ]
                  },
                  "budgetTokens": {
                    "type": "integer",
                    "minimum": 1024,
                    "maximum": 9007199254740991
                  },
                  "display": {
                    "type": "string",
                    "enum": [
                      "summarized",
                      "omitted"
                    ]
                  }
                },
                "required": [
                  "_tag",
                  "budgetTokens"
                ],
                "additionalProperties": true
              },
              {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "BetweenTools"
                    ]
                  }
                },
                "required": [
                  "_tag"
                ],
                "additionalProperties": true
              },
              {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "Off"
                    ]
                  }
                },
                "required": [
                  "_tag"
                ],
                "additionalProperties": true
              }
            ]
          },
          "effort": {
            "type": "string",
            "enum": [
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max"
            ]
          },
          "limits": {
            "type": "object",
            "properties": {
              "contextWindow": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "maxOutputTokens": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              }
            },
            "additionalProperties": true
          },
          "promptCache": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "Auto"
                    ]
                  },
                  "ttl": {
                    "type": "string",
                    "enum": [
                      "5m",
                      "1h"
                    ]
                  }
                },
                "required": [
                  "_tag",
                  "ttl"
                ],
                "additionalProperties": true
              },
              {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "TopLevel"
                    ]
                  },
                  "ttl": {
                    "type": "string",
                    "enum": [
                      "5m",
                      "1h"
                    ]
                  }
                },
                "required": [
                  "_tag",
                  "ttl"
                ],
                "additionalProperties": true
              },
              {
                "type": "object",
                "properties": {
                  "_tag": {
                    "type": "string",
                    "enum": [
                      "Off"
                    ]
                  }
                },
                "required": [
                  "_tag"
                ],
                "additionalProperties": true
              }
            ]
          }
        },
        "additionalProperties": true
      }
    },
    "storage": {
      "type": "string",
      "enum": [
        "local",
        "memory"
      ]
    },
    "credentials": {
      "type": "object",
      "additionalProperties": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "api_key"
                ]
              },
              "key": {
                "type": "string"
              }
            },
            "required": [
              "type",
              "key"
            ],
            "additionalProperties": true
          },
          {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "oauth"
                ]
              },
              "access": {
                "type": "string"
              },
              "refresh": {
                "type": "string"
              },
              "expires": {
                "type": "number"
              },
              "accountId": {
                "type": "string"
              },
              "installationId": {
                "type": "string"
              }
            },
            "required": [
              "type",
              "access",
              "refresh",
              "expires"
            ],
            "additionalProperties": true
          },
          {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "local"
                ]
              },
              "baseUrl": {
                "type": "string"
              }
            },
            "required": [
              "type"
            ],
            "additionalProperties": true
          }
        ]
      }
    },
    "credentialEnv": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "proxy": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "string"
        }
      ]
    },
    "noProxy": {
      "type": "string"
    },
    "thinkingPrefixMismatch": {
      "type": "string",
      "enum": [
        "provider-default",
        "drop_block",
        "error"
      ]
    },
    "spend": {
      "type": "object",
      "properties": {
        "prices": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "input": {
                "type": "number",
                "minimum": 0
              },
              "output": {
                "type": "number",
                "minimum": 0
              },
              "cacheRead": {
                "type": "number",
                "minimum": 0
              },
              "cacheWrite": {
                "type": "number",
                "minimum": 0
              },
              "reasoning": {
                "type": "number",
                "minimum": 0
              }
            },
            "required": [
              "input",
              "output",
              "cacheRead",
              "cacheWrite"
            ],
            "additionalProperties": true
          }
        },
        "turnCap": {
          "type": "number",
          "minimum": 0
        },
        "totalCap": {
          "type": "number",
          "minimum": 0
        },
        "uncappedOutputTokens": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "inputBytesPerToken": {
          "type": "number",
          "minimum": 1
        }
      },
      "required": [
        "prices"
      ],
      "additionalProperties": true
    }
  },
  "required": [
    "model",
    "fastModel",
    "fallbackModel",
    "inheritPrevious",
    "endpoints",
    "modelSettings",
    "storage",
    "credentials",
    "credentialEnv",
    "proxy",
    "noProxy",
    "thinkingPrefixMismatch"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
