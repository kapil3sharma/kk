const fs = require('fs');
const html = fs.readFileSync('quant_engine_live.html', 'utf8');
const lines = html.split('\n');

console.log(lines.slice(6035, 6085).join('\n'));

