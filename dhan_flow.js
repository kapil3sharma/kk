'use strict';
/*
 Dhan NIFTY FUTURES depth feed -> REAL order flow ticks (volume delta + best bid/ask + side).
 Dhan WebSocket v2 Full packet (code 8, 162 bytes, little-endian):
   0 respCode(1) | 1 msgLen(2) | 3 segment(1) | 4 securityId(4)
   8 LTP f32 | 12 LTQ i16 | 14 LTT i32 | 18 ATP f32 | 22 Volume i32 | 26 SellQty i32 | 30 BuyQty i32 | 34 OI i32 | 38 hiOI | 42 loOI
   46 open | 50 close | 54 high | 58 low | 62.. 5 x depth(20): bidQty i32, askQty i32, bidOrders i16, askOrders i16, bidPrice f32, askPrice f32
 NOTE: ye layout Dhan docs se hai aur maine live feed se verify nahi kiya. Isliye sanity checks hain; fail hone par
 server apne aap inferred mode me wapas chala jata hai. Pehle din DEBUG_FLOW=1 chala kar log dekho.
*/
const IST = 19800000;
const SCRIP_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

function parseFull(b) {
  if (!Buffer.isBuffer(b) || b.length < 162 || b.readUInt8(0) !== 8) return null;
  const depth = [];
  for (let i = 0; i < 5; i++) { const o = 62 + i * 20; depth.push({ bq: b.readInt32LE(o), aq: b.readInt32LE(o + 4), bp: b.readFloatLE(o + 12), ap: b.readFloatLE(o + 16) }); }
  return { secId: b.readInt32LE(4), seg: b.readUInt8(3), ltp: b.readFloatLE(8), ltq: b.readInt16LE(12), atp: b.readFloatLE(18), volume: b.readInt32LE(22), sellQty: b.readInt32LE(26), buyQty: b.readInt32LE(30), oi: b.readInt32LE(34), depth };
}
function sane(p, ref) {
  if (!p || !(p.ltp > 1000) || !isFinite(p.ltp)) return false;
  if (ref && Math.abs(p.ltp - ref) / ref > 0.03) return false;           // futures index se 3% se zyada door nahi hota
  const d = p.depth[0];
  if (!(d.bp > 0) || !(d.ap > 0) || d.bp > d.ap * 1.001) return false;
  if (Math.abs(d.bp - p.ltp) / p.ltp > 0.01 || Math.abs(d.ap - p.ltp) / p.ltp > 0.01) return false;
  return p.volume >= 0;
}
function makeTickBuilder() {
  let lastVol = null, lastSide = 1, lastPx = 0;
  return function (p, now) {
    if (lastVol == null || p.volume < lastVol) { lastVol = p.volume; return null; }   // pehla packet / din ka reset
    const qty = p.volume - lastVol; lastVol = p.volume;
    if (qty <= 0 || qty > 500000) return null;
    const d = p.depth[0];
    let side;
    if (p.ltp >= d.ap) side = 1; else if (p.ltp <= d.bp) side = -1;
    else { const mid = (d.ap + d.bp) / 2; side = p.ltp > mid ? 1 : p.ltp < mid ? -1 : (lastPx ? (p.ltp > lastPx ? 1 : p.ltp < lastPx ? -1 : lastSide) : 1); }
    lastSide = side; lastPx = p.ltp;
    const r = x => Math.round(x * 20) / 20;
    return { type: 'tick', ts: now || Date.now(), price: r(p.ltp), qty, bid: r(d.bp), ask: r(d.ap), bidQty: d.bq, askQty: d.aq, side, flow: 'real' };
  };
}
async function resolveNiftyFuture(istDate) {   // istDate = 'YYYY-MM-DD'
  const r = await fetch(SCRIP_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('scrip master HTTP ' + r.status);
  const lines = (await r.text()).split(/\r?\n/);
  const h = lines[0].split(',').map(x => x.trim());
  const ix = n => h.indexOf(n);
  const [cE, cI, cS, cT, cX, cL] = ['SEM_EXM_EXCH_ID', 'SEM_INSTRUMENT_NAME', 'SEM_SMST_SECURITY_ID', 'SEM_TRADING_SYMBOL', 'SEM_EXPIRY_DATE', 'SEM_LOT_UNITS'].map(ix);
  if ([cE, cI, cS, cT, cX].some(i => i < 0)) throw new Error('scrip master columns badal gaye: ' + h.slice(0, 12).join('|'));
  const cands = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]; if (l.indexOf('FUTIDX') < 0 || l.indexOf('NIFTY-') < 0) continue;
    const c = l.split(',');
    if (c[cE] !== 'NSE' || c[cI] !== 'FUTIDX' || !String(c[cT]).startsWith('NIFTY-')) continue;
    const exp = String(c[cX]).slice(0, 10);
    if (exp > istDate) cands.push({ secId: String(c[cS]).trim(), symbol: c[cT], expiry: exp, lot: cL >= 0 ? parseInt(c[cL], 10) : null });   // expiry din agle mahine ka lo (liquidity wahin)
  }
  cands.sort((a, b) => a.expiry.localeCompare(b.expiry));
  if (!cands.length) throw new Error('NIFTY futures scrip master me nahi mila');
  return cands[0];
}
module.exports = { parseFull, sane, makeTickBuilder, resolveNiftyFuture };
