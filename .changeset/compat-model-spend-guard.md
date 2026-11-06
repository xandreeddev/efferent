---
"@xandreed/plugin-models": minor
---

A compat model the host builds itself reserves and settles each send's spend: `CompatConfig.spend` (`ModelSpendGuard`, exported from `@xandreed/plugin-models/compat`: a `ModelSpend` ledger and decoded `ModelSpendOptions`) guards every physical send of a `makeCompatLanguageModel` model, retries included, as the models plugin's `spend` option guards a routed call: each send reserves its worst case for the turn before it goes out and settles at the cost of its reported usage, buffered or streamed; a send past a cap is never sent and fails with `model.spend`. The guard is the model's own: the plugin's `spend` option guards only the calls the plugin routes, and the plugin no longer leaves its guard among the services it builds, so a host model stacked beside it (`stackPlugins` over the plugin's built services) is never priced or capped by the plugin's guard; a host model without `spend` is not guarded.
