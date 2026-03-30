const http = require('http');
const TOKEN = process.argv[2];
if (!TOKEN) { console.error('Usage: node bulk-cancel-local.js <jwt_token>'); process.exit(1); }

const data = JSON.stringify({});
const opts = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/admin/purchases/bulk-cancel',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + TOKEN,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
};

const req = http.request(opts, res => {
  let b = '';
  res.on('data', d => b += d);
  res.on('end', () => console.log('Status:', res.statusCode, '| Result:', b));
});
req.write(data);
req.end();
