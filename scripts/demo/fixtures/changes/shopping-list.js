export function renderShoppingList(recipes) {
  const aisles = Map.groupBy(recipes.flatMap((recipe) => recipe.ingredients.map((name) => ({ name, aisle: recipe.aisle }))), (item) => item.aisle);
  return `<section aria-labelledby="list-title"><h2 id="list-title">Shopping list</h2>${[...aisles].map(([aisle, items]) => `<fieldset><legend>${aisle}</legend>${items.map((item) => `<label><input type="checkbox">${item.name}</label>`).join('')}</fieldset>`).join('')}</section>`;
}
