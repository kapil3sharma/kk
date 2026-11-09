'use strict';
// Paper trading journal: closed signals paper_trades.ndjson me jama hote hain, stats yahan se nikalte hain.
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, 'paper_trades.ndjson');
let trades = [], keys = new Set();
try { if (fs.existsSync(FILE)) for (const l of fs.readFileSync(FILE, 'utf8').split('\n')) { if (!l.trim()) continue; try { const t = JSON.parse(l); trades.push(t); keys.add(t.key); } catch (e) {} } } catch (e) {}

function add(t) {
  if (!t || !t.key || keys.has(t.key) || !isFinite(t.r) || !isFinite(t.rupee)) return false;
  const rec = { key: String(t.key), date: String(t.date), time: String(t.time || ''), side: t.side === 'SHORT' ? 'SHORT' : 'LONG', grade: String(t.grade || ''), level: String(t.level || ''), score: +t.score || 0, lots: +t.lots || 0,
    entry: +t.entry, stop: +t.stop, tp1: +t.tp1, exit: +t.exit, result: String(t.result || ''), net_pts: +t.net_pts || 0, rupee: +t.rupee, r: +t.r, flow: t.flow === 'real' ? 'real' : 'inferred', mode: String(t.mode || ''), logged: Date.now() };
  trades.push(rec); keys.add(rec.key);
  try { fs.appendFileSync(FILE, JSON.stringify(rec) + '\n'); } catch (e) { console.warn('[Paper]', e.message); }
  return true;
}
function agg(arr) {
  const n = arr.length; if (!n) return { n: 0 };
  let eq = 0, peak = 0, dd = 0, gw = 0, gl = 0, w = 0, sr = 0, ss = 0;
  for (const t of arr) { eq += t.rupee; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); if (t.rupee > 0) { w++; gw += t.rupee; } else gl -= t.rupee; sr += t.r; ss += t.r * t.r; }
  const m = sr / n, sd = n > 1 ? Math.sqrt(Math.max(0, (ss - n * m * m) / (n - 1))) : 0, se = n > 1 ? sd / Math.sqrt(n) : 0;
  const r2 = x => Math.round(x * 100) / 100;
  return { n, win: r2(w / n * 100), net: Math.round(eq), expR: r2(m), ci: [r2(m - 1.96 * se), r2(m + 1.96 * se)], pf: gl > 0 ? r2(gw / gl) : (gw > 0 ? 99 : 0), maxDD: Math.round(dd) };
}
function group(arr, f) { const g = {}; for (const t of arr) (g[f(t)] = g[f(t)] || []).push(t); return Object.entries(g).map(([k, v]) => Object.assign({ key: k }, agg(v))); }
function stats() {
  const real = trades.filter(t => t.flow === 'real'), all = trades;
  const days = new Set(all.map(t => t.date)).size;
  let eq = 0; const equity = all.map(t => Math.round(eq += t.rupee)).slice(-300);
  const base = real.length ? real : all, a = agg(base);
  let verdict, vl;
  if (!a.n) { verdict = 'Abhi koi paper trade nahi. Server chalne do.'; vl = 'wait'; }
  else if (a.n < 30 || days < 20) { verdict = 'KAM DATA: ' + a.n + '/30 trades, ' + days + '/20 din. Abhi koi nateeja nahi nikalta.'; vl = 'wait'; }
  else if (a.ci[0] > 0 && a.pf >= 1.2) { verdict = 'Edge ke ishare (expectancy ' + a.expR + 'R, 95% range ' + a.ci[0] + ' se ' + a.ci[1] + '). Phir bhi chhote size se hi aage badho.'; vl = 'good'; }
  else if (a.ci[1] < 0) { verdict = 'NEGATIVE: expectancy ' + a.expR + 'R. Strategy paisa kha rahi hai. Real paisa mat lagao.'; vl = 'bad'; }
  else { verdict = 'PROVEN NAHI: expectancy ' + a.expR + 'R, 95% range ' + a.ci[0] + ' se ' + a.ci[1] + ' (zero ko paar karti hai).'; vl = 'wait'; }
  if (a.n && !real.length) verdict += ' (Sab trades inferred order flow par hain, kamzor evidence.)';
  return { total: all.length, days, all: agg(all), real: agg(real), verdictBasis: real.length ? 'real-flow trades' : 'all trades', verdict, vl, equity,
    byGrade: group(base, t => t.grade), byLevel: group(base, t => t.level), bySide: group(base, t => t.side),
    byDay: group(all, t => t.date).slice(-15), recent: all.slice(-12).reverse() };
}
module.exports = { add, stats };
