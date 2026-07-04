(function () {
  const searchInput = document.getElementById('searchInput');
  const filterTags = document.getElementById('filterTags');
  const recipeGrid = document.getElementById('recipeGrid');
  const noResults = document.getElementById('noResults');

  if (!searchInput || !filterTags || !recipeGrid) return;

  const cards = Array.from(recipeGrid.querySelectorAll('.recipe-card'));
  let activeFilter = 'all';

  function updateVisibility() {
    const query = searchInput.value.trim().toLowerCase();
    let visibleCount = 0;

    cards.forEach(card => {
      const category = card.dataset.category || '';
      const ingredients = card.dataset.ingredients || '';
      const title = card.querySelector('.recipe-title')?.textContent.toLowerCase() || '';
      const desc = card.querySelector('.recipe-desc')?.textContent.toLowerCase() || '';

      const matchesFilter = activeFilter === 'all' || category.includes(activeFilter);
      const matchesSearch = !query ||
        title.includes(query) ||
        desc.includes(query) ||
        ingredients.includes(query);

      if (matchesFilter && matchesSearch) {
        card.hidden = false;
        card.style.display = '';
        visibleCount++;
      } else {
        card.hidden = true;
        card.style.display = 'none';
      }
    });

    if (noResults) {
      noResults.hidden = visibleCount > 0;
    }
  }

  searchInput.addEventListener('input', updateVisibility);

  filterTags.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-tag');
    if (!btn) return;

    filterTags.querySelectorAll('.filter-tag').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    updateVisibility();
  });

  // Ingredient checklist on recipe detail pages
  document.querySelectorAll('.ingredient-check').forEach(check => {
    check.addEventListener('click', () => {
      check.classList.toggle('checked');
      const text = check.nextElementSibling;
      if (text) text.classList.toggle('checked');
    });
  });
})();
