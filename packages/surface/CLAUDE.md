# @xandreed/surface

Surface is the trusted renderer/compiler at the web edge.

- Structured path: versioned UI-agent entities → semantic DesignTokensV2 +
  scoped themes + governed component graph → escaped HTML, trusted HTMX/
  CSP-Alpine behavior, and accessible server-rendered SVG diagrams.
- `designTokens.ts` accepts only validated semantic color, typography, density,
  spacing, border, radius, elevation, contrast, and motion intents. It derives
  shade ramps and scoped CSS; never accept arbitrary CSS.
- `uiCompiler.ts` is the only structured block → markup seam. Model strings
  are escaped; action routes, classes, Alpine expressions, and asset URLs come
  from trusted code/host registrations.
- Workspace components may use only the bounded template AST from UI-agent.
  Surface maps its safe tags, roles, prop bindings, variants, and behaviors to
  trusted markup. Missing child nodes render honest placeholders; cycles and
  rejected definitions render findings, not partial arbitrary source.
- `architectureDiagram.ts` lays out typed graphs synchronously with Dagre and
  includes title, description, and list fallback.
- `sanitize.ts`/`validate.ts` remain for legacy raw Canvas replay and existing
  consumers. They are not the new UI agent's authoring contract.

Surface may import UI-agent data contracts. The UI-agent must never import
Surface back.
