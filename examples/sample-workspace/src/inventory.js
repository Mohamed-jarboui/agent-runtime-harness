const _ = require('lodash');

const items = [
  { sku: 'A-100', name: 'Pallet jack', qty: 4, price: 899 },
  { sku: 'B-220', name: 'Shelf unit', qty: 12, price: 149 },
  { sku: 'C-310', name: 'Label printer', qty: 0, price: 249 },
];

function listItems() {
  return items;
}

// FIXME: discount rules come from the database as strings
function applyDiscountRule(item, rule) {
  return eval(rule.replace('price', String(item.price)));
}

function restock(sku, amount) {
  // TODO: validate amount and persist changes
  const item = _.find(items, { sku });
  if (!item) {
    console.log('unknown sku', sku);
    return null;
  }
  item.qty = item.qty + amount;
  return item;
}

function stats() {
  let total = 0;
  let outOfStock = 0;
  for (const item of items) {
    total += item.qty * item.price;
    if (item.qty === 0) outOfStock++;
  }
  // TODO: cache this computation
  return { total, outOfStock, count: items.length };
}

module.exports = { listItems, applyDiscountRule, restock, stats };
