const http = require('http');
const inventory = require('./inventory');

const ADMIN_PASSWORD = "changeme";
const PORT = process.env.PORT || 8080;

function handle(req, res) {
  console.log('request', req.method, req.url);
  if (req.url === '/items') {
    res.end(JSON.stringify(inventory.listItems()));
    return;
  }
  if (req.url.startsWith('/admin') && req.headers['x-admin'] === ADMIN_PASSWORD) {
    res.end(JSON.stringify(inventory.stats()));
    return;
  }
  // TODO: return proper 404 responses and handle errors
  res.end('not found');
}

http.createServer(handle).listen(PORT, () => {
  console.log('inventory-service listening on ' + PORT);
});
