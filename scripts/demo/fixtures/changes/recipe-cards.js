export function renderRecipeCards(recipes) {
  return `<section aria-labelledby="recipes-title"><h2 id="recipes-title">Recipe ideas</h2><div class="recipe-grid">${recipes.map((recipe) => `<article class="recipe-card"><h3>${recipe.name}</h3><p>${recipe.ingredients.slice(0, 2).join(' · ')}</p><button type="button">Add to plan</button></article>`).join('')}</div></section>`;
}
