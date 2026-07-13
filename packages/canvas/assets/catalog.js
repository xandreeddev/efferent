var search=document.getElementById("ef-component-search")
if(search)search.addEventListener("input",function(){
  var query=search.value.trim().toLowerCase()
  document.querySelectorAll("[data-component-card]").forEach(function(card){card.hidden=query.length>0&&card.dataset.componentCard.toLowerCase().indexOf(query)<0})
})
var themes=document.getElementById("ef-theme-select")
if(themes)themes.addEventListener("change",function(){document.body.dataset.uiTheme=themes.value})
