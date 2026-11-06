---
"@xandreed/evals-cli": patch
---

Repeated list flags merge: `--task`, `--candidate`, `--grader` and `--exporter` given more than once (or as comma lists) select every value, each once in first-seen order, instead of only the first occurrence. A single-valued flag given twice with different values is a usage error (`invalid`) instead of silently using its first value. `cliArguments` adds `list` and `singleValued`.
