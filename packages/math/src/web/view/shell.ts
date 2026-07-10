import { html, render } from "@xandreed/surface"
import { ID_APP, ID_RESYNC_FORM } from "../ids.js"
import { assetHref } from "../static.js"
import { mathBodyContents } from "./fragments.js"
import type { MathShellView } from "./types.js"

/**
 * The standalone `efferent math` document — a PRODUCT shell, not the web
 * canvas: no chat composer, no transcript drawer, no tabs, no Tailwind. The
 * default DARK theme is hard-stamped (`<html data-theme="efferent">` — no
 * picker, no localStorage script; "efferent" is tokens.css's `:root`), every
 * visible surface paints `--tok-*` tokens through math.css, and the only
 * scripts are htmx + its ws extension +
 * the tiny math.js (hardening, conn badge, resync, focus). Interactions are
 * typed `/action/*` POSTs rendered by the server; DOM updates arrive as OOB
 * fragments over the WebSocket (`mathBodyContents` is shared with the
 * full-sync builder so the initial page and a reconnect can never drift).
 */
export const renderMathShell = (view: MathShellView): string => {
  const doc = html`<!doctype html>
<html lang="en" data-theme="efferent">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>${view.title}</title>
<link rel="icon" href="data:," />
<link rel="stylesheet" href="${assetHref("tokens.css")}" />
<link rel="stylesheet" href="${assetHref("math.css")}" />
<script src="${assetHref("htmx.min.js")}"></script>
<script src="${assetHref("htmx-ext-ws.js")}"></script>
<script src="${assetHref("math.js")}" defer></script>
</head>
<body>
<div id="${ID_APP}" class="ef-m-shell" hx-ext="ws" ws-connect="${view.wsUrl}">
  ${mathBodyContents(view)}
  <form id="${ID_RESYNC_FORM}" ws-send hx-trigger="ef:resync from:body" hidden>
    <input type="hidden" name="type" value="resync" />
  </form>
</div>
</body>
</html>`
  return render(doc)
}
