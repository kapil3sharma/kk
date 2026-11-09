#!/usr/bin/env node
'use strict';
/*
 STRATEGY LAB: asli recorded NIFTY ticks par har strategy variant ko test karke rank karta hai.

 Chalane ka tarika (folder me jahan server.js aur quant_engine_live.html hain):
     node strategy_lab.js                      -> folder ki saari ticks-*.ndjson files use karta hai
     node strategy_lab.js file1.ndjson ...     -> sirf di hui files
     node strategy_lab.js --allow-sim          -> simulated files ko bhi chalne deta hai (sirf pipeline test ke liye)

 Kya karta hai:
   1. Har din ko alag engine me replay karta hai (VWAP, IB, volume profile har din reset).
   2. 8 variants chalata hai (reversion, with-trend pullback, bias gate, grade, score, filters).
   3. Din ke hisaab se pehle 60% (train) aur baaki 40% (test) me todta hai. Ranking sirf TEST par.
   4. Har variant ko stress test deta hai (slippage 2x, costs 1.5x).
   5. Sirf wahi variant recommend karta hai jo saari shartein pass kare, warna saaf bolta hai ki koi nahi.
*/
const fs = require('fs'), path = require('path'), vm = require('vm');
global.window = global;

const HTML = path.join(__dirname, 'quant_engine_live.html');
const args = process.argv.slice(2);
const allowSim = args.includes('--allow-sim');
const allowInferred = args.includes('--allow-inferred');   // Dhan index feed ke tick-rule wale ticks (real order flow nahi)
let files = args.filter(a => !a.startsWith('--'));
if (!files.length) {
  // Pehle server ke recorded ticks-*.ndjson (real), phir candle-derived dhan_nifty_* (sirf --allow-sim ke saath use hote hain)
  const all = fs.readdirSync(__dirname);
  files = all.filter(f => /^ticks-.*\.ndjson$/.test(f)).sort().map(f => path.join(__dirname, f));
  if (!files.length) files = all.filter(f => /^dhan_nifty_.*\.ndjson$/.test(f)).map(f => path.join(__dirname, f));
}
if (!files.length) {
  console.log('Koi ticks-*.ndjson ya dhan_nifty_*.ndjson file nahi mili.\nServer (node server.js) market hours me chalao: wo har din ticks-YYYY-MM-DD.ndjson khud banata hai.\nKam se kam 10 din ka data chahiye, 20+ behtar.');
  process.exit(0);
}

// ---- load the exact engine used by the dashboard ----
const page = fs.readFileSync(HTML, 'utf8');
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const engineSrc = scripts.find(s => s.includes('const QE=') || s.includes('const QE ='));
if (!engineSrc) { console.error('Engine quant_engine_live.html me nahi mila.'); process.exit(1); }
const QE = vm.runInThisContext(engineSrc + ';QE');   // same context = ~5x faster than a sandbox

// ---- load and split data by trading day ----
const days = {};
let skippedSim = 0, skippedSynth = 0, skippedInferred = 0;
for (const f of files) {
  if (/sim/i.test(path.basename(f)) && !allowSim) { skippedSim++; console.log('Skip (simulated file): ' + path.basename(f) + '  (--allow-sim se chala sakte ho, par result bekaar hoga)'); continue; }
  for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
    const s = ln.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch (e) { continue; }
    if (o.ts == null) continue;
    if (o.type !== 'chain') {                                       // only real order-flow ticks
      const candleDerived = /^dhan_nifty_/.test(path.basename(f));  // 1-min candle se bane, qty/depth random
      if ((o.synthetic || candleDerived) && !allowSim) { skippedSynth++; continue; }
      if (o.noflow && !allowInferred) { skippedInferred++; continue; }
    }
    const dk = Math.floor((o.ts + 19800000) / 86400000);
    (days[dk] = days[dk] || []).push(o);
  }
}
if (skippedSynth || skippedInferred) console.log('\nSkip kiye: ' + skippedSynth + ' candle-derived/synthetic ticks (random qty/depth), ' + skippedInferred + ' inferred-flow ticks (Dhan index feed).\nSirf real order-flow ticks (Kite futures recording) gine gaye. --allow-sim / --allow-inferred se include kar sakte ho, par result sirf andaza hoga.');
const dayKeys = Object.keys(days).sort();
const prepared = [];
for (const k of dayKeys) {
  const arr = days[k].sort((a, b) => (a.ts - b.ts) || (a.type === 'chain' ? -1 : (b.type === 'chain' ? 1 : 0)));
  const items = arr.map(o => o.type === 'chain' ? { type: 'chain', chain: o.chain }
    : { t: ((o.ts + 19800000) / 1000) % 86400, ts: o.ts, p: o.price, q: o.qty || 1, bid: o.bid, ask: o.ask, bq: o.bidQty, aq: o.askQty, side: o.side })
    .filter(x => x.type === 'chain' || (x.t >= 33300 && x.t <= 55800));
  const nTicks = items.filter(x => x.type !== 'chain').length;
  if (nTicks >= 2000) prepared.push({ date: new Date(+k * 86400000).toISOString().slice(0, 10), items, nTicks });
}
console.log('\nDin mile: ' + prepared.length + (prepared.length ? '  (' + prepared[0].date + ' se ' + prepared[prepared.length - 1].date + ')' : ''));
if (prepared.length < 10) {
  console.log('\nRUKO: ' + prepared.length + ' din bahut kam hain. Itne kam data par koi bhi ranking sirf andaza hogi.');
  console.log('Server har market din record karta rahe. 10 din minimum, 20+ din behtar. Phir ye script dobara chalao.');
  if (!prepared.length) process.exit(0);
}

// ---- variants ----
const VARIANTS = [
  { id: 'A', name: 'OLD: tight stops, no confirmation',      cfg: { stopAtr: 0, confirmTicks: 0 } },
  { id: 'B', name: 'Current default (ATR 0.6, confirm 5)',    cfg: {} },
  { id: 'C', name: 'Wider stop: ATR 0.8, confirm 5',          cfg: { stopAtr: 0.8 } },
  { id: 'D', name: 'Wider stop: ATR 1.0, confirm 5',          cfg: { stopAtr: 1.0 } },
  { id: 'E', name: 'Default, confirm 15 ticks',               cfg: { confirmTicks: 15 } },
  { id: 'F', name: 'Default + avoid midday',                  cfg: { avoidMidday: true } },
  { id: 'G', name: 'Default, grade A only',                   cfg: { minGrade: 'A' } },
  { id: 'H', name: 'Default, score >= 75',                    cfg: { minScore: 75 } },
  { id: 'I', name: 'With-trend pullback only',                cfg: { enableReversion: false } },
  { id: 'J', name: 'Reversion only + bias gate',              cfg: { enableContinuation: false } },
  { id: 'K', name: 'Reversion only, no bias gate',            cfg: { enableContinuation: false, useBiasGate: false } },
  { id: 'L', name: 'Default, filters OFF',                    cfg: { useFilters: false } }
];
const base = QE.defaultCfg();

function runVariant(v, over, fromDay) {
  const trades = [];
  prepared.forEach((d, di) => {
    if (fromDay && di < fromDay) return;
    const r = QE.replay(d.items, Object.assign({}, base, v.cfg, over || {}));
    r.signals.filter(s => s.status !== 'OPEN').forEach(s => trades.push({ day: di, date: d.date, r: s.r, rupee: s.rupee, dir: s.dir, level: s.level, grade: s.grade, status: s.status, risk: s.risk, mae: s.mae, mfe: s.mfe, hunt: !!s.stopHunt }));
  });
  return trades;
}
function metrics(trades) {
  const n = trades.length; if (!n) return { n: 0, win: 0, net: 0, pf: 0, expR: 0, dd: 0, profDays: 0 };
  let eq = 0, peak = 0, dd = 0, gw = 0, gl = 0, w = 0, sr = 0; const byDay = {};
  for (const t of trades) { eq += t.rupee; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; if (t.rupee > 0) { w++; gw += t.rupee; } else gl -= t.rupee; sr += t.r; byDay[t.day] = (byDay[t.day] || 0) + t.rupee; }
  const dv = Object.values(byDay);
  return { n, win: w / n, net: eq, pf: gl > 0 ? gw / gl : (gw > 0 ? 99 : 0), expR: sr / n, dd, profDays: dv.length ? dv.filter(x => x > 0).length / dv.length : 0 };
}

const split = Math.max(1, Math.floor(prepared.length * 0.6));
const results = [];
console.log('\nChala raha hoon: ' + VARIANTS.length + ' variants x ' + prepared.length + ' din (train: pehle ' + split + ' din, test: baaki ' + (prepared.length - split) + ')...\n');
for (const v of VARIANTS) {
  process.stdout.write('  ' + v.id + ' ' + v.name + ' ... ');
  const all = runVariant(v);
  const train = all.filter(t => t.day < split), test = all.filter(t => t.day >= split);
  const stress = test.length >= 15 ? runVariant(v, { slip: base.slip * 2, costMult: 1.5 }, split) : [];   // stress only on the unseen test days
  const mA = metrics(all), mT = metrics(train), mX = metrics(test), mS = metrics(stress);
  let verdict;
  if (mX.n < 15) verdict = 'TOO FEW TRADES';
  else if (mX.expR <= 0 || mX.pf < 1) verdict = 'REJECT';
  else if (mS.n >= 15 && mS.pf < 1) verdict = 'FRAGILE (fails stress)';
  else if (mX.n >= 30 && mX.pf >= 1.3 && mT.expR > 0 && mS.pf >= 1.1) verdict = 'PROVEN (so far)';
  else if (mX.pf >= 1.1) verdict = 'PROMISING';
  else verdict = 'WEAK';
  results.push({ v, mA, mT, mX, mS, verdict, all });
  console.log(all.length + ' trades');
}

const f2 = x => (Math.round(x * 100) / 100).toString(), rs = x => (x < 0 ? '-' : '') + '₹' + Math.abs(Math.round(x)).toLocaleString('en-IN');
const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
console.log('\n' + pad('ID', 3) + pad('Variant', 42) + lpad('Trades', 7) + lpad('TEST win', 9) + lpad('TEST PF', 8) + lpad('TEST expR', 10) + lpad('TEST net', 12) + lpad('Stress PF', 10) + lpad('MaxDD', 11) + '  Verdict');
console.log('-'.repeat(125));
const ranked = results.slice().sort((a, b) => (b.mX.n >= 15) - (a.mX.n >= 15) || b.mX.expR - a.mX.expR);
for (const r of ranked) {
  console.log(pad(r.v.id, 3) + pad(r.v.name, 42) + lpad(r.mA.n, 7) + lpad(r.mX.n ? Math.round(r.mX.win * 100) + '%' : '-', 9) + lpad(r.mX.n ? f2(r.mX.pf) : '-', 8) + lpad(r.mX.n ? f2(r.mX.expR) + 'R' : '-', 10) + lpad(rs(r.mX.net), 12) + lpad(r.mS.n ? f2(r.mS.pf) : '-', 10) + lpad(rs(r.mA.dd), 11) + '  ' + r.verdict);
}

const good = ranked.filter(r => r.verdict === 'PROVEN (so far)' || r.verdict === 'PROMISING');
console.log('\n=== RECOMMENDATION ===');
if (!good.length) {
  console.log('Koi bhi variant shartein pass nahi karta. Abhi real paisa mat lagao. Paper trading chalao, aur zyada din ka data jama karo.');
} else {
  const b = good[0];
  console.log('Behtar variant (sirf TEST din ke hisaab se): ' + b.v.id + ' - ' + b.v.name + '   [' + b.verdict + ']');
  console.log('TEST: ' + b.mX.n + ' trades, win ' + Math.round(b.mX.win * 100) + '%, profit factor ' + f2(b.mX.pf) + ', expectancy ' + f2(b.mX.expR) + 'R, net ' + rs(b.mX.net) + '; stress PF ' + f2(b.mS.pf));
  fs.writeFileSync(path.join(__dirname, 'recommended_settings.json'), JSON.stringify({ variant: b.v.id, name: b.v.name, cfg: b.v.cfg, verdict: b.verdict, testStats: b.mX, generated: new Date().toISOString() }, null, 2));
  console.log('Settings recommended_settings.json me save ho gayi.');
}
// ---- why are stops being hit? (uses MAE/MFE of every trade) ----
console.log('\n=== STOP DIAGNOSIS (saare din, har variant) ===');
console.log(pad('ID', 3) + lpad('Trades', 7) + lpad('Stopped', 9) + lpad('Avg risk', 10) + lpad('MFE of stopped', 16) + lpad('Stop-hunt', 11) + lpad('Avg MAE', 9));
for (const r of results) {
  const tr = r.all; const st = tr.filter(t => t.status === 'STOP');
  const avg = (a, f) => a.length ? a.reduce((x, t) => x + f(t), 0) / a.length : 0;
  r.diag = { n: tr.length, stopPct: tr.length ? st.length / tr.length : 0, risk: avg(tr, t => t.risk), mfeS: avg(st, t => t.mfe / t.risk), hunt: st.length ? st.filter(t => t.hunt).length / st.length : 0, mae: avg(tr, t => t.mae / t.risk) };
  console.log(pad(r.v.id, 3) + lpad(r.diag.n, 7) + lpad(Math.round(r.diag.stopPct * 100) + '%', 9) + lpad(f2(r.diag.risk) + ' pts', 10) + lpad(f2(r.diag.mfeS) + 'R', 16) + lpad(Math.round(r.diag.hunt * 100) + '%', 11) + lpad(f2(r.diag.mae) + 'R', 9));
}
const dB = (results.find(r => r.v.id === 'B') || results[0]).diag;
console.log('\nCurrent default ka nidaan:');
if (dB.n < 15) console.log(' - Trades bahut kam hain, nidaan bharosemand nahi.');
else if (dB.hunt >= 0.30) console.log(' - Stop-hunt ' + Math.round(dB.hunt * 100) + '%: stop lagne ke BAAD bhi price target tak gaya. Stop bahut tight hai. C/D (wider ATR stop) ko dekho.');
else if (dB.mfeS < 0.35) console.log(' - Stopped trades me price kabhi apne favour me ' + f2(dB.mfeS) + 'R se zyada nahi gaya. Matlab entry ka direction ya timing galat tha, stop ka size nahi. E (zyada confirmation), G (grade A) ya J/I dekho.');
else console.log(' - Stop-hunt aur MFE dono theek lag rahe hain. Stop-outs normal noise jaise hain. Edge sabit karne ke liye TEST wali ranking par bharosa karo.');
console.log('\nSAVDHANI:');
console.log(' - ' + VARIANTS.length + ' variants me se best chunne par result thoda zyada acha dikhta hai (overfitting). Isliye sabse bharosemand tareeka: chune hue variant ko NAYE, aane wale dinon par paper trade karo.');
console.log(' - Backtest me fills perfect maane jaate hain. Asli order me slippage zyada ho sakti hai.');
console.log(' - Pichla performance bhavishya ki guarantee nahi hai.');
if (skippedSim) console.log(' - ' + skippedSim + ' simulated file skip ki gayi.');
fs.writeFileSync(path.join(__dirname, 'strategy_lab_result.json'), JSON.stringify(results.map(r => ({ id: r.v.id, name: r.v.name, verdict: r.verdict, all: r.mA, train: r.mT, test: r.mX, stress: r.mS })), null, 2));
console.log('\nPoora result strategy_lab_result.json me hai.');