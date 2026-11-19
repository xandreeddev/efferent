---
"@xandreed/sdk": minor
---

The kernel's Node entry gains `openAiCompatibleEmbedder`, an `Embedder` over the OpenAI-compatible `/embeddings`
endpoint that charges the spend ledger as the model providers do, its name carrying the model, the dimensions and the
prefixes; `spendRefusalOf` and `isSpendRefusal` read the ledger's refusal from an `EmbedFailed` too (ADR 0032).
