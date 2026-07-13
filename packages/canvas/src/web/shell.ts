import { html, raw, render } from "@xandreed/surface"

export const renderShell = (csrfToken: string): string => render(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>efferent canvas</title><link rel="stylesheet" href="/assets/theme.css" /><link rel="stylesheet" href="/assets/app.css" />
<script src="/assets/htmx.min.js"></script><script src="/assets/htmx-ext-ws.js"></script><script defer src="/assets/alpine.min.js"></script></head>
<body><div id="ef-shell" class="ef-shell" hx-ext="ws" ws-connect="/ws"><header class="ef-topbar"><span class="ef-mark">▌efferent canvas</span>${raw(`<nav id="ef-tabs" class="ef-tabs-bar"></nav>`)}</header>
${raw(`<main id="ef-pages" class="ef-pages-host"><div id="ef-skeleton" class="ef-skeleton" hidden><div class="ef-skeleton-bar ef-skeleton-wide"></div><div class="ef-skeleton-bar"></div><div class="ef-skeleton-bar ef-skeleton-short"></div></div></main>`)}<footer class="ef-dockbar">${raw(`<div id="ef-status" class="ef-status-strip"></div>`)}
<form class="ef-ask" hx-post="/action/chat" hx-swap="none" autocomplete="off"><input type="hidden" name="csrf" value="${csrfToken}" /><input type="hidden" name="page" id="ef-viewing" value="" /><input class="ef-ask-input" name="prompt" placeholder="build me a page…" autofocus /><button class="ef-ask-send" type="submit">send</button></form></footer></div><script src="/assets/app.js"></script></body></html>`)
