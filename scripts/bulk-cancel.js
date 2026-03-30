const https = require('https');
const TOKEN = process.argv[2];
if (!TOKEN) { console.error('Usage: node bulk-cancel.js <jwt_token>'); process.exit(1); }

const data = JSON.stringify({});
const opts = {
  hostname: 'janction.net',
  path: '/api/admin/purchases/bulk-cancel',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + TOKEN,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
};

const req = https.request(opts, res => {
  let b = '';
  res.on('data', d => b += d);
  res.on('end', () => console.log('Result:', b));
});
req.write(data);
req.end();
