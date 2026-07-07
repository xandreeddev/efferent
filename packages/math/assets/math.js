/* efferent math — client glue. Deliberately tiny: the server renders every
 * state change; this file only hardens htmx, paints the conn badge, self-heals
 * a missed OOB target with a resync, and keeps the answer input ready to type.
 * No frameworks, no state — the DOM the server sends IS the state. */
;(function () {
  "use strict"

  // htmx hardening (mirror of app.js): no eval'd attributes, no script tags
  // from swapped content, same-origin requests only, no history cache.
  if (window.htmx && window.htmx.config) {
    window.htmx.config.allowEval = false
    window.htmx.config.allowScriptTags = false
    window.htmx.config.selfRequestsOnly = true
    window.htmx.config.historyEnabled = false
  }

  // The header is a server-rendered singleton — every upsert resets the badge
  // to its default, so the LAST KNOWN state re-applies after every message
  // (the app.js conn-badge discipline).
  var connOpen = false
  var conn = function () {
    var el = document.getElementById("ef-conn")
    if (!el) return
    el.classList.toggle("ef-m-conn--open", connOpen)
    el.classList.toggle("ef-m-conn--closed", !connOpen)
    el.textContent = connOpen ? "●" : "○"
  }
  document.body.addEventListener("htmx:wsOpen", function () { connOpen = true; conn() })
  document.body.addEventListener("htmx:wsClose", function () { connOpen = false; conn() })

  // Self-healing resync: an OOB fragment that found no target means our DOM
  // drifted from the server's model — ask for a full sync (debounced).
  var resyncTimer = null
  document.body.addEventListener("htmx:oobErrorNoTarget", function () {
    if (resyncTimer !== null) return
    resyncTimer = setTimeout(function () {
      resyncTimer = null
      document.body.dispatchEvent(new CustomEvent("ef:resync", { bubbles: true }))
    }, 250)
  })

  // After a WS message settles: re-apply the conn badge (a header upsert just
  // reset it) and put the cursor in the answer field — but never steal focus
  // from something the student is already typing in.
  document.body.addEventListener("htmx:wsAfterMessage", function () {
    conn()
    var active = document.activeElement
    if (active && active !== document.body && active.tagName !== "BUTTON") return
    var card = document.getElementById("ef-m-card")
    if (!card) return
    var input = card.querySelector('input[name="value"]:not([type="radio"])')
    if (input) input.focus()
  })
})()
