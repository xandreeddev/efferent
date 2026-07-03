/* efferent web — client glue. Vanilla, no build step. Everything here is
   defensive: the page works (read-only) even if this file fails to load.
   Client-held UI state (open drawers, pinned tab, dismissed reply) is
   re-applied after every WS message — server upserts repaint their regions
   in a static state, and wsAfterMessage fires post-settle, so the re-apply
   always wins (the conn-badge discipline). */
(function () {
  "use strict";

  /* htmx hardening — the systemic backstop behind the server-side sanitizer. */
  if (typeof htmx !== "undefined") {
    htmx.config.allowEval = false;
    htmx.config.allowScriptTags = false;
    htmx.config.selfRequestsOnly = true;
    htmx.config.historyEnabled = false;
  }

  var d = document;

  /* ---------- theme ---------- */

  try {
    var saved = localStorage.getItem("ef-theme");
    if (saved) d.documentElement.setAttribute("data-theme", saved);
  } catch (e) { /* private mode */ }

  d.addEventListener("change", function (ev) {
    var t = ev.target;
    if (t && t.classList && t.classList.contains("ef-theme-pick")) {
      d.documentElement.setAttribute("data-theme", t.value);
      try { localStorage.setItem("ef-theme", t.value); } catch (e) { /* ignore */ }
    }
  });

  /* Keep the theme picker showing the active theme after header upserts. */
  var syncPicker = function () {
    var pick = d.querySelector(".ef-theme-pick");
    if (pick) pick.value = d.documentElement.getAttribute("data-theme") || "efferent";
  };

  /* ---------- drawers (transcript left · references right) ---------- */

  var drawerId = { chat: "ef-chat-drawer", refs: "ef-refs-drawer" };
  var drawerOpen = { chat: false, refs: false };

  var paintDrawers = function () {
    for (var name in drawerId) {
      var el = d.getElementById(drawerId[name]);
      if (el) el.classList.toggle("ef-drawer--open", drawerOpen[name]);
    }
  };

  var setDrawer = function (name, open) {
    if (!(name in drawerOpen)) return;
    drawerOpen[name] = open;
    paintDrawers();
    if (name === "chat" && open) {
      unread = false;
      paintUnread();
      var chatEl = d.getElementById("ef-chat");
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight; /* re-pin on open */
    }
  };

  d.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest("[data-drawer-toggle]");
    if (!t) return;
    var name = t.getAttribute("data-drawer-toggle");
    setDrawer(name, !drawerOpen[name]);
  });

  d.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (drawerOpen.refs) { setDrawer("refs", false); return; }
    if (drawerOpen.chat) { setDrawer("chat", false); }
  });

  /* ---------- references: click a linked pill → open + flash its card ---------- */

  d.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest("[data-ref]");
    if (!t) return;
    var ref = t.getAttribute("data-ref");
    if (!ref) return;
    setDrawer("refs", true);
    var card = d.getElementById(ref);
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.classList.add("ef-ref-flash");
    setTimeout(function () { card.classList.remove("ef-ref-flash"); }, 2000);
  });

  /* Header refs count = the drawer's card count (repainted post-settle). */
  var paintRefsCount = function () {
    var badge = d.getElementById("ef-refs-count");
    var stack = d.getElementById("ef-ws-items");
    if (!badge || !stack) return;
    var n = stack.children.length;
    badge.textContent = n > 0 ? String(n) : "";
  };

  /* ---------- page tabs (client-pinned; auto-follow otherwise) ---------- */

  var pinnedPage = null; /* DOM id of the user's explicit tab choice */

  var activatePage = function (domId) {
    var pages = d.querySelectorAll("#ef-canvas > .ef-page");
    for (var i = 0; i < pages.length; i++) {
      pages[i].classList.toggle("ef-page--active", pages[i].id === domId);
    }
    var tabs = d.querySelectorAll(".ef-tab");
    var rawId = "";
    for (var j = 0; j < tabs.length; j++) {
      var isIt = tabs[j].getAttribute("data-page") === domId;
      tabs[j].classList.toggle("ef-tab--active", isIt);
      if (isIt) rawId = tabs[j].getAttribute("data-page-id") || "";
    }
    /* Tell the agent which page the user is looking at ([viewing:…]). */
    var field = d.querySelector("#ef-composer input[name=page]");
    if (field) field.value = rawId;
  };

  d.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest(".ef-tab[data-page]");
    if (!t) return;
    pinnedPage = t.getAttribute("data-page");
    activatePage(pinnedPage);
  });

  /* After every message, pick the viewed page by precedence:
     1. a fresh data-focus marker (the agent explicitly pulled the user here —
        adopt it as the pin, then strip the marker so re-applies don't re-fire);
     2. the user's pinned tab, while its page still exists;
     3. the server's active tab (moves only on focus events — a background
        render never yanks the view);
     4. the last page (newest). */
  var syncPages = function () {
    var pages = d.querySelectorAll("#ef-canvas > .ef-page");
    if (pages.length === 0) return;
    var focused = d.querySelector("#ef-canvas > .ef-page[data-focus]");
    if (focused) {
      var marked = d.querySelectorAll("#ef-canvas > .ef-page[data-focus]");
      for (var i = 0; i < marked.length; i++) marked[i].removeAttribute("data-focus");
      pinnedPage = focused.id;
    }
    var target = null;
    if (pinnedPage && d.getElementById(pinnedPage)) target = pinnedPage;
    if (!target) {
      var activeTab = d.querySelector(".ef-tab--active");
      var fromTab = activeTab && activeTab.getAttribute("data-page");
      if (fromTab && d.getElementById(fromTab)) target = fromTab;
    }
    if (!target) target = pages[pages.length - 1].id;
    activatePage(target);
  };

  /* ---------- composer ---------- */

  d.addEventListener("keydown", function (ev) {
    var t = ev.target;
    if (!t || t.name !== "prompt" || t.tagName !== "TEXTAREA") return;
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      var form = t.closest("form");
      if (form && t.value.trim() !== "") htmx.trigger(form, "submit");
    }
  });

  d.addEventListener("htmx:wsAfterSend", function (ev) {
    var elt = ev.detail && ev.detail.elt;
    if (elt && elt.id === "ef-composer") {
      var ta = elt.querySelector("textarea[name=prompt]");
      if (ta) { ta.value = ""; ta.style.height = ""; }
    }
  });

  /* Autogrow the composer up to its CSS max-height. */
  d.addEventListener("input", function (ev) {
    var t = ev.target;
    if (!t || t.name !== "prompt" || t.tagName !== "TEXTAREA") return;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 180) + "px";
  });

  /* Empty-stage suggestions prefill the composer. */
  d.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest("[data-suggest]");
    if (!t) return;
    var ta = d.querySelector("#ef-composer textarea[name=prompt]");
    if (!ta) return;
    ta.value = t.getAttribute("data-suggest") || "";
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });

  /* ---------- transcript scroll pin ---------- */

  var chat = null;
  var nearBottom = true;
  var trackChat = function () {
    chat = d.getElementById("ef-chat");
    if (!chat) return;
    chat.addEventListener("scroll", function () {
      nearBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60;
    });
    var rail = d.getElementById("ef-rail");
    if (rail && typeof MutationObserver !== "undefined") {
      new MutationObserver(function () {
        if (nearBottom) chat.scrollTop = chat.scrollHeight;
      }).observe(rail, { childList: true, subtree: true, characterData: true });
    }
  };

  /* ---------- reply bubble (dismiss by key) + unread dot ---------- */

  var dismissedKey = null;
  var lastReplyKey = null;
  var unread = false;

  var paintUnread = function () {
    var dot = d.querySelector('[data-drawer-toggle="chat"] .ef-unread-dot');
    if (dot) dot.hidden = !unread;
  };

  d.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest(".ef-reply-dismiss");
    if (!t) return;
    var bubble = d.getElementById("ef-reply");
    if (!bubble) return;
    dismissedKey = bubble.getAttribute("data-key");
    bubble.classList.add("ef-reply--hidden");
  });

  var syncReply = function () {
    var bubble = d.getElementById("ef-reply");
    if (!bubble) return;
    var key = bubble.getAttribute("data-key");
    if (!key) return;
    /* Same dismissed key ⇒ stay hidden; a NEW key shows again. */
    bubble.classList.toggle("ef-reply--hidden", key === dismissedKey);
    if (key !== lastReplyKey) {
      lastReplyKey = key;
      if (!drawerOpen.chat) { unread = true; paintUnread(); }
    }
  };

  /* ---------- activity elapsed ticker ---------- */

  var tickTimer = null;
  var syncActivity = function () {
    var strip = d.getElementById("ef-activity");
    var startedAt = strip ? parseInt(strip.getAttribute("data-started-at") || "", 10) : NaN;
    var busy = strip && !strip.classList.contains("ef-activity--idle") && !isNaN(startedAt);
    if (!busy) {
      if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
      return;
    }
    var paint = function () {
      var el = d.getElementById("ef-activity");
      if (!el) return;
      var out = el.querySelector(".ef-activity-elapsed");
      if (!out) return;
      var s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      out.textContent = s < 60 ? s + "s" : Math.floor(s / 60) + "m" + (s % 60) + "s";
    };
    paint();
    if (tickTimer !== null) clearInterval(tickTimer);
    tickTimer = setInterval(paint, 1000);
  };

  /* ---------- connection badge + boot state ---------- */

  var connOpen = false;
  var setConn = function (open) {
    connOpen = open;
    paintConn();
    d.body.classList.toggle("ef-conn-wait", !open);
  };
  var paintConn = function () {
    var conn = d.getElementById("ef-conn");
    if (!conn) return;
    conn.classList.toggle("ef-conn--open", connOpen);
    conn.classList.toggle("ef-conn--closed", !connOpen);
    conn.textContent = connOpen ? "●" : "○";
  };
  d.addEventListener("htmx:wsOpen", function () { setConn(true); });
  d.addEventListener("htmx:wsClose", function () { setConn(false); });

  /* ---------- the post-settle re-apply pass ---------- */

  /* Every received frame proves the socket is open AND repaints client-held
     state — singleton upserts re-render their regions statically, and
     wsAfterMessage fires post-settle, so this always wins. */
  var afterMessage = function () {
    setConn(true);
    syncPicker();
    syncPages();
    paintRefsCount();
    syncReply();
    syncActivity();
    paintDrawers();
    paintUnread();
  };
  d.addEventListener("htmx:wsAfterMessage", afterMessage);

  var boot = function () {
    syncPicker();
    trackChat();
    syncPages();
    paintRefsCount();
    syncActivity();
  };
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", boot);
  else boot();

  /* Self-healing: an OOB fragment found no target → ask for a full resync
     (debounced). The hidden #ef-resync form ws-sends {type:"resync"}. */
  var resyncTimer = null;
  d.addEventListener("htmx:oobErrorNoTarget", function () {
    if (resyncTimer !== null) return;
    resyncTimer = setTimeout(function () {
      resyncTimer = null;
      d.body.dispatchEvent(new CustomEvent("ef:resync", { bubbles: true }));
    }, 250);
  });
})();
