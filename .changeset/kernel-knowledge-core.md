---
"@xandreed/sdk": minor
---

The kernel holds the pure core of memory kept by a curator (ADR 0022): the knowledge session's eight records and their
fold `knowledgeOf`, a turn as a source (`turnSource`), what a curator is shown (`shownFor`), the pinned prompts
(`curationPrompt`, `reviewPrompt`), the reply's reader and checks (`curationOf`, `staged`, `draftsOf`), and the
`Curator` contract a host provides, with its kit `curatorConformance`. Also `clipTo` and `clippedMarker`.
