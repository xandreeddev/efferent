---
"@xandreed/core": patch
"@xandreed/plugin-memory": patch
"@xandreed/plugin-rag": patch
---

Extracted spans whose quote differs from the source only in typography are anchored instead of dropped. When a span's quote is nowhere in the source exactly, staging (and each window of a split source) compares it again with curly and straight quotes and apostrophes, primes, hyphens, dashes and the minus sign, and no-break, narrow no-break and figure spaces folded to their plain forms, one UTF-16 unit to one so offsets stay the source's. The nearest such occurrence to the proposed offset wins, and the span takes the source's exact text there as its quote, so staging's checks and the stored provenance carry the source's text. Exact matching still comes first, and a quote that matches neither way is still dropped with its `RecordDropped` note. No prompt or output schema changes, so the extraction version stays the same.
