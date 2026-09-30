import { renderWeeklyPlan } from './weekly-plan.js';
import { renderRecipeCards } from './recipe-cards.js';
import { renderShoppingList } from './shopping-list.js';

const recipes = [
  { name: 'Lemon chickpea bowls', aisle: 'Produce', ingredients: ['lemons', 'parsley', 'chickpeas'] },
  { name: 'Roasted tomato pasta', aisle: 'Pantry', ingredients: ['tomatoes', 'pasta', 'basil'] },
  { name: 'Miso mushroom rice', aisle: 'Produce', ingredients: ['mushrooms', 'scallions', 'rice'] },
];

document.querySelector('#app').innerHTML = [
  renderWeeklyPlan(),
  renderRecipeCards(recipes),
  renderShoppingList(recipes),
].join('');
