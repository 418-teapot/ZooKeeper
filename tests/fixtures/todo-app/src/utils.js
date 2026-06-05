function calculateTotal(items) {
  // Bug: crashes when items is undefined — should default to []
  return items.reduce((sum, item) => sum + item.price, 0);
}

module.exports = { calculateTotal };