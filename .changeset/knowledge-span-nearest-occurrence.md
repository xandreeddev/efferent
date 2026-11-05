---
"@xandreed/core": patch
---

Knowledge extraction re-anchors a quote that occurs more than once in the source to its occurrence nearest the proposed offset, instead of rejecting the whole extraction. Extraction models quote reliably but rarely count characters exactly, so a name repeated in a conversation (said by the user and echoed in the reply) failed every memory job that cited it. A quote that is not in the source is still rejected.
