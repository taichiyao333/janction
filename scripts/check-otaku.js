const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { initDb, getDb } = require('../server/db/database');

initDb().then(() => {
    const db = getDb();

    // List tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables:', tables.map(t => t.name).join(', '));

    // User info
    const user = db.prepare('SELECT id, username, point_balance, wallet_balance FROM users WHERE id = 15').get();
    console.log('\n=== USER ===');
    console.log(user);

    // Reservations (without JOIN to gpus)
    const reservations = db.prepare(`
        SELECT * FROM reservations
        WHERE renter_id = 15
        ORDER BY created_at DESC
        LIMIT 5
    `).all();
    console.log('\n=== RESERVATIONS ===');
    reservations.forEach(r => {
        console.log(`  #${r.id} | status=${r.status} | gpu_id=${r.gpu_id} | ${r.start_time} ~ ${r.end_time} | price=${r.total_price}`);
    });

    // Check if gpu_nodes table exists
    try {
        const gpuTable = tables.find(t => t.name.includes('gpu'));
        if (gpuTable) {
            const gpu = db.prepare(`SELECT * FROM ${gpuTable.name} WHERE id = ?`).get(reservations[0]?.gpu_id);
            console.log('\n=== GPU INFO ===');
            console.log(gpu);
        }
    } catch(e) { console.log('GPU info error:', e.message); }

    // Check pods table
    try {
        const pods = db.prepare(`
            SELECT * FROM pods
            WHERE reservation_id IN (SELECT id FROM reservations WHERE renter_id = 15)
            ORDER BY created_at DESC LIMIT 5
        `).all();
        console.log('\n=== PODS ===');
        pods.forEach(p => console.log(p));
    } catch(e) { console.log('No pods table or error:', e.message); }

    // Check usage_logs
    try {
        const logs = db.prepare(`
            SELECT * FROM usage_logs
            WHERE reservation_id IN (SELECT id FROM reservations WHERE renter_id = 15)
            ORDER BY created_at DESC LIMIT 5
        `).all();
        console.log('\n=== USAGE LOGS ===');
        logs.forEach(l => console.log(l));
    } catch(e) { console.log('No usage_logs or error:', e.message); }

    process.exit(0);
});
