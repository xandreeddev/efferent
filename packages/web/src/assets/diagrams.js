/* efferent web — the mermaid pass. The model authors diagram SOURCE TEXT
   (never SVG — the sanitizer bans it): <pre class="ef-mermaid"> in render_ui
   pages, ```mermaid fences in chat markdown. This file finds unrendered
   sources after every swap, lazily injects the vendored mermaid script on
   first sight, and renders each to an inline SVG figure — per-node error
   containment, so one bad diagram never breaks a page. Defensive like app.js:
   without it the source blocks stay visible as code. */
(function () {
  "use strict";

  var d = document;
  var state = "cold"; // cold → loading → ready | failed
  var pending = false;
  var seq = 0;

  /* Mermaid theme variables from the live design tokens, so diagrams follow
     the active theme. Re-read on every (re)initialize. Returns null when the
     tokens aren't available (tokens.css failed) — no hex fallbacks here; we
     fall back to mermaid's built-in dark theme instead. */
  var themeVars = function () {
    var s = getComputedStyle(d.documentElement);
    var v = function (name) { return s.getPropertyValue(name).trim(); };
    if (v("--tok-surface-panel") === "") return null;
    return {
      background: v("--tok-surface-panel"),
      primaryColor: v("--tok-surface-raised"),
      primaryTextColor: v("--tok-text-default"),
      primaryBorderColor: v("--tok-surface-border"),
      secondaryColor: v("--tok-surface-panel"),
      tertiaryColor: v("--tok-surface-page"),
      lineColor: v("--tok-text-dim"),
      textColor: v("--tok-text-default"),
      fontFamily: v("--font-ui") || "system-ui, sans-serif",
      fontSize: "14px",
    };
  };

  var initMermaid = function () {
    var tv = themeVars();
    window.mermaid.initialize(
      tv === null
        ? { startOnLoad: false, securityLevel: "strict", theme: "dark" }
        : { startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: tv }
    );
  };

  var ensureLoaded = function () {
    if (state !== "cold") return;
    var app = d.getElementById("ef-app");
    var src = app && app.getAttribute("data-mermaid-src");
    if (!src) { state = "failed"; return; }
    state = "loading";
    var tag = d.createElement("script");
    tag.src = src;
    tag.onload = function () {
      if (typeof window.mermaid === "undefined") { state = "failed"; return; }
      try { initMermaid(); state = "ready"; renderAll(); } catch (e) { state = "failed"; }
    };
    tag.onerror = function () { state = "failed"; };
    d.head.appendChild(tag);
  };

  /* Unrendered sources: kit blocks + markdown fences. A server upsert that
     replaces a rendered figure brings back a fresh un-marked <pre>, so the
     next pass naturally re-renders it — self-correcting with keyed OOB. */
  var findSources = function () {
    return d.querySelectorAll(
      "pre.ef-mermaid:not([data-mm-done]), .ef-codeblock[data-lang=\"mermaid\"]:not([data-mm-done])"
    );
  };

  var renderNode = function (node) {
    node.setAttribute("data-mm-done", "1");
    var source = (node.textContent || "").trim();
    if (source === "") return;
    var id = "ef-mm-" + (++seq) + "-" + Math.floor(Math.random() * 1e6);
    window.mermaid
      .render(id, source)
      .then(function (out) {
        var fig = d.createElement("figure");
        fig.className = "ef-figure ef-mermaid-out";
        fig.setAttribute("data-mm-src", source);
        fig.setAttribute("data-mm-done", "1");
        fig.innerHTML = out.svg; /* mermaid-generated (strict), never model HTML */
        if (node.parentNode) node.parentNode.replaceChild(fig, node);
      })
      .catch(function (err) {
        /* Parse failure: keep the source visible, append the message, and
           remove mermaid's leftover error artifact (it injects one into
           <body> when render rejects). */
        var orphan = d.getElementById(id);
        if (orphan && orphan.parentNode) orphan.parentNode.removeChild(orphan);
        var note = d.createElement("div");
        note.className = "ef-mermaid-error";
        note.textContent = "diagram failed to render: " + (err && err.message ? err.message : "parse error");
        if (node.parentNode) node.parentNode.insertBefore(note, node.nextSibling);
      });
  };

  var renderAll = function () {
    var nodes = findSources();
    if (nodes.length === 0) return;
    if (state === "cold") { ensureLoaded(); return; }
    if (state !== "ready") { pending = state === "loading"; return; }
    for (var i = 0; i < nodes.length; i++) renderNode(nodes[i]);
  };

  /* Theme switch: re-init with fresh token values, re-render every diagram
     from its kept source. */
  d.addEventListener("change", function (ev) {
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains("ef-theme-pick")) return;
    if (state !== "ready") return;
    /* The theme attribute flips in app.js's own change listener; defer one
       tick so the computed styles we read are the new theme's. */
    setTimeout(function () {
      try { initMermaid(); } catch (e) { return; }
      var figs = d.querySelectorAll("figure[data-mm-src]");
      for (var i = 0; i < figs.length; i++) {
        (function (fig) {
          var source = fig.getAttribute("data-mm-src") || "";
          if (source === "") return;
          var id = "ef-mm-" + (++seq) + "-t";
          window.mermaid.render(id, source).then(function (out) {
            fig.innerHTML = out.svg;
          }).catch(function () { /* keep the old rendering */ });
        })(figs[i]);
      }
    }, 0);
  });

  var schedule = function () {
    if (state === "loading") { pending = true; return; }
    renderAll();
    if (pending && state === "ready") { pending = false; renderAll(); }
  };

  d.addEventListener("htmx:wsAfterMessage", schedule);
  d.addEventListener("htmx:afterSettle", schedule);
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", schedule);
  else schedule();
})();
