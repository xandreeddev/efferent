# Issue tracker reference architecture

- Entity files contain Effect Schema definitions and derived types only.
- Entity behavior lives in the paired `.entity.functions.ts` file.
- Use-case contracts and behavior are split into `.usecase.ts` and `.usecase.functions.ts`.
- Ports are `Context.Tag` contracts returning Effects. Adapters bridge foreign APIs and export Layers.
- Domain and use-case code never interprets Effects or orchestrates raw Promises.
- `main.ts` is the only production composition root.
