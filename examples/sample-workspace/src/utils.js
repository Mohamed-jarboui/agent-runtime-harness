function formatPrice(cents) {
  return (cents / 100).toFixed(2);
}

// HACK: crude slug implementation, replace with a library
function slug(text) {
  return text.toLowerCase().split(' ').join('-');
}

module.exports = { formatPrice, slug };
