const https = require('https');
const fs = require('fs');

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, res => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                fs.unlink(dest, () => {});
                return download(res.headers.location, dest).then(resolve).catch(reject);
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(dest); });
        }).on('error', err => { try { fs.unlink(dest, () => {}); } catch(_){} reject(err); });
    });
}

const libs = [
    ['https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js', 'public/lib/chart.umd.min.js'],
    ['https://cdn.socket.io/4.7.2/socket.io.min.js', 'public/lib/socket.io.min.js'],
    ['https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js', 'public/lib/xterm.min.js'],
    ['https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js', 'public/lib/xterm-addon-fit.min.js'],
    ['https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css', 'public/lib/xterm.css'],
];

(async () => {
    for (const [url, dest] of libs) {
        try {
            if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
                console.log(`SKIP (exists): ${dest}`);
            } else {
                process.stdout.write(`Downloading ${dest}... `);
                await download(url, dest);
                console.log(`OK (${fs.statSync(dest).size} bytes)`);
            }
        } catch (e) {
            console.log(`FAIL: ${e.message}`);
        }
    }
    console.log('All done.');
    process.exit(0);
})();
