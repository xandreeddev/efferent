htmx.config.allowEval=false;
htmx.config.allowScriptTags=false;
htmx.config.selfRequestsOnly=true;

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

var knownPages=[];

document.body.addEventListener("htmx:oobAfterSwap", function () {
  var pages = Array.from(document.querySelectorAll(".ef-page-host"));
  var ids = pages.map(function (p) { return p.dataset.page; });
  var fresh = ids.filter(function (id) { return knownPages.indexOf(id) < 0; });
  knownPages = ids;
  if (fresh.length > 0) { activate(fresh[fresh.length - 1]); return; }
  var pinned = document.getElementById("ef-viewing");
  var current = pinned && pinned.value;
  if (current && ids.indexOf(current) >= 0) { activate(current); return; }
  var serverActive = pages.find(function (p) { return !p.hidden; }) || pages[pages.length - 1];
  if (serverActive) activate(serverActive.dataset.page);
});

document.body.addEventListener("htmx:afterRequest", function (e) {
  if (e.detail.elt && e.detail.elt.classList.contains("ef-ask")) {
    e.detail.elt.querySelector(".ef-ask-input").value = "";
  }
});
