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

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-models` · Version **0.17.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `effect/ai/LanguageModel`, `@xandreed/core/UtilityLlm`, `@xandreed/core/AuthStore`, `@xandreed/core/SettingsStore`, `@xandreed/core/ModelCatalog` |
| Requires | `efferent/SessionEnvironment` |
| Uses when available | `@xandreed/plugin-models/HostCredentials`, `@xandreed/plugin-models/ModelsTransport` |
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
