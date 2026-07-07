/* canvas client glue — tabs + viewing context + htmx hardening. No framework. */
htmx.config.allowEval = false;
htmx.config.allowScriptTags = false;
htmx.config.selfRequestsOnly = true;

function activate(id) {
  document.querySelectorAll(".ef-page-host").forEach(function (el) {
    el.hidden = el.dataset.page !== id;
  });
  document.querySelectorAll(".ef-tab-btn").forEach(function (el) {
    el.classList.toggle("is-active", el.dataset.tab === id);
  });
  var viewing = document.getElementById("ef-viewing");
  if (viewing) viewing.value = id;
}

document.addEventListener("click", function (e) {
  var tab = e.target.closest && e.target.closest(".ef-tab-btn");
  if (tab) activate(tab.dataset.tab);
});

/* After any WS swap: keep the pinned tab authoritative; adopt the server's
   active tab only when the user has none pinned. */
document.body.addEventListener("htmx:oobAfterSwap", function () {
  var pinned = document.getElementById("ef-viewing");
  var current = pinned && pinned.value;
  var pages = Array.from(document.querySelectorAll(".ef-page-host"));
  if (current && pages.some(function (p) { return p.dataset.page === current; })) {
    activate(current);
    return;
  }
  var serverActive = pages.find(function (p) { return !p.hidden; }) || pages[pages.length - 1];
  if (serverActive) activate(serverActive.dataset.page);
});

/* Clear the composer after a send. */
document.body.addEventListener("htmx:afterRequest", function (e) {
  if (e.detail.elt && e.detail.elt.classList.contains("ef-ask")) {
    e.detail.elt.querySelector(".ef-ask-input").value = "";
  }
});
