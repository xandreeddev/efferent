# @xandreed/surface

Surface is the trusted renderer/compiler at the web edge.

- Structured path: versioned UI-agent entities → semantic token CSS + standard
  landing/application/document recipes → escaped HTML, trusted HTMX/CSP-Alpine
  behavior, and accessible server-rendered SVG diagrams.
- `designTokens.ts` accepts only semantic hex colors, registered font IDs, and
  closed scale variants. Never accept arbitrary CSS.
- `uiCompiler.ts` is the only structured block → markup seam. Model strings
  are escaped; action routes, classes, Alpine expressions, and asset URLs come
  from trusted code/host registrations.
- `architectureDiagram.ts` lays out typed graphs synchronously with Dagre and
  includes title, description, and list fallback.
- `sanitize.ts`/`validate.ts` remain for legacy raw Canvas replay and existing
  consumers. They are not the new UI agent's authoring contract.

Surface may import UI-agent data contracts. The UI-agent must never import
Surface back.
