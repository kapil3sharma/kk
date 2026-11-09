const fs = require('fs');
const html = fs.readFileSync('quant_engine_live.html', 'utf8');
const lines = html.split('\n');

console.log('--- Lines 9050-9150 ---');
console.log(lines.slice(9050, 9150).join('\n'));
console.log('--- Lines 9150-9260 ---');
console.log(lines.slice(9150, 9260).join('\n'));

