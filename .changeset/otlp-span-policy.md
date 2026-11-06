---
"@xandreed/plugin-telemetry": minor
---

The OTLP export layers take a `spans` policy (`OtlpSpanPolicy`): `keep` drops a span, its children reparented to its nearest kept ancestor, and `attribute` rewrites or leaves out span and span-event attributes before they reach the exporter.
