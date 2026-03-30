const https = require('https');

const TOKEN = process.argv[2];
if (!TOKEN) { console.error('Usage: node check-pending.js <jwt_token>'); process.exit(1); }

const opts = {
  hostname: 'janction.net',
  path: '/api/admin/purchases?status=pending',
  headers: { 'Authorization': 'Bearer ' + TOKEN }
};

https.get(opts, res => {
  let b = '';
  res.on('data', d => b += d);
  res.on('end', () => {
    const arr = JSON.parse(b);
    console.log('=== Pending Purchases: ' + arr.length + ' ===\n');
    arr.forEach(p => {
      const order = p.epsilon_order ? p.epsilon_order.substring(0, 30) : 'N/A';
      console.log('ID:' + p.id + ' | ' + p.email + ' | Y' + p.amount_yen + ' | ' + p.points + 'pt | order:' + order + ' | ' + p.created_at);
    });
  });
});
