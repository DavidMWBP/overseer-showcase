export function renderRecipeCards(recipes) {
  return `<section aria-labelledby="recipes-title"><h2 id="recipes-title">Recipe ideas</h2><div class="recipe-grid">${recipes.map((recipe) => `<article><h3>${recipe.name}</h3></article>`).join('')}</div></section>`;
}
