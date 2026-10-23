
An application can bind an `ExecutionReceipt` Layer to record durable admission before its
subject runs. `defineRunnable` signals readiness after decoding the input and opening its
world; the receipt Layer is scoped once per evaluation and may memoize its write across
trials. Output-directory and selection errors, or a world that cannot open, do not consume
that receipt. Captured reports carrying `receipt:policy` require their application config
when compared by the CLI; ordinary saved comparisons remain configuration-free.
`defineGraderCalibration` also exposes its input and reference codecs for strict holdout
registration rather than maintaining a second list of schemas.
