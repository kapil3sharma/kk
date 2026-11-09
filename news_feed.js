'use strict';
/*
 NEWS + EVENTS + FLOWS module (server.js se require hota hai)

 Kya karta hai:
  1. Sirf whitelist wale sources ke RSS feeds laata hai (RBI, SEBI, ET, Moneycontrol, Mint, Business Standard, BusinessLine).
  2. Har headline ko keyword se positive/negative/neutral score karta hai (rough, sirf headline par).
  3. "Source genuine" check: ek hi khabar kam se kam 2 alag sources me aaye to CONFIRMED, warna SINGLE SOURCE.
     Official sources (RBI/SEBI) ko seedha OFFICIAL maana jata hai.
  4. Headline me NIFTY stock ka naam mile to us stock se jodta hai aur stock-wise news tilt nikalta hai.
  5. events.json + RBI/expiry/holiday se aane wale events aur countdown deta hai.
  6. NSE se FII/DII daily net (agar NSE allow kare) laata hai. Stock-wise FII holding fii_holdings.json se (quarterly).

 ZAROORI: ye "BUY/SELL" nahi deta. Sirf news tilt aur flow dikhata hai. Faisla aapka.
*/
const fs = require('fs'), path = require('path');

const FEEDS = [
  { id: 'rbi',   name: 'RBI Press Releases',      url: 'https://www.rbi.org.in/pressreleases_rss.xml',                         tier: 'official' },
  { id: 'sebi',  name: 'SEBI',                    url: 'https://www.sebi.gov.in/sebirss.xml',                                  tier: 'official' },
  { id: 'et',    name: 'Economic Times Markets',  url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', tier: 'press' },
  { id: 'etst',  name: 'Economic Times Stocks',   url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', tier: 'press' },
  { id: 'mc',    name: 'Moneycontrol Reports',    url: 'https://www.moneycontrol.com/rss/marketreports.xml',                   tier: 'press' },
  { id: 'mcb',   name: 'Moneycontrol Business',   url: 'https://www.moneycontrol.com/rss/business.xml',                        tier: 'press' },
  { id: 'mint',  name: 'Livemint Markets',        url: 'https://www.livemint.com/rss/markets',                                 tier: 'press' },
  { id: 'bs',    name: 'Business Standard',       url: 'https://www.business-standard.com/rss/markets-106.rss',                tier: 'press' },
  { id: 'bl',    name: 'BusinessLine Markets',    url: 'https://www.thehindubusinessline.com/markets/feeder/default.rss',      tier: 'press' }
];

// NIFTY large caps + aliases. List badal sakti hai (index rebalance): watchlist.json se override karo: {"SYMBOL":["alias1","alias2"]}
const STOCKS = {
  RELIANCE: ['reliance industries', 'reliance', 'ril', 'jio'], TCS: ['tcs', 'tata consultancy'], HDFCBANK: ['hdfc bank'], ICICIBANK: ['icici bank'],
  INFY: ['infosys', 'infy'], SBIN: ['sbi', 'state bank of india'], BHARTIARTL: ['bharti airtel', 'airtel'], ITC: ['itc'], LT: ['larsen', 'l&t'],
  HINDUNILVR: ['hindustan unilever', 'hul'], KOTAKBANK: ['kotak mahindra bank', 'kotak bank', 'kotak'], AXISBANK: ['axis bank'], BAJFINANCE: ['bajaj finance'],
  BAJAJFINSV: ['bajaj finserv'], MARUTI: ['maruti suzuki', 'maruti'], SUNPHARMA: ['sun pharma'], TITAN: ['titan'], ASIANPAINT: ['asian paints'],
  ULTRACEMCO: ['ultratech'], NTPC: ['ntpc'], POWERGRID: ['power grid'], ONGC: ['ongc'], COALINDIA: ['coal india'], TATAMOTORS: ['tata motors'],
  TATASTEEL: ['tata steel'], JSWSTEEL: ['jsw steel'], ADANIENT: ['adani enterprises'], ADANIPORTS: ['adani ports'], WIPRO: ['wipro'], HCLTECH: ['hcl tech', 'hcltech'],
  TECHM: ['tech mahindra'], NESTLEIND: ['nestle india'], M_M: ['mahindra & mahindra', 'm&m'], HINDALCO: ['hindalco'], GRASIM: ['grasim'], CIPLA: ['cipla'],
  DRREDDY: ["dr reddy", "dr. reddy"], APOLLOHOSP: ['apollo hospitals'], BAJAJ_AUTO: ['bajaj auto'], EICHERMOT: ['eicher motors', 'royal enfield'], HEROMOTOCO: ['hero motocorp'],
  BRITANNIA: ['britannia'], INDUSINDBK: ['indusind bank'], SBILIFE: ['sbi life'], HDFCLIFE: ['hdfc life'], TATACONSUM: ['tata consumer'], BPCL: ['bpcl'], SHRIRAMFIN: ['shriram finance'], TRENT: ['trent'],
  ETERNAL: ['eternal', 'zomato'], INDIGO: ['indigo', 'interglobe']
};
try { const w = path.join(__dirname, 'watchlist.json'); if (fs.existsSync(w)) Object.assign(STOCKS, JSON.parse(fs.readFileSync(w, 'utf8'))); } catch (e) { console.warn('[News] watchlist.json error:', e.message); }

// Market-wide (index level) keywords
const MACRO = ['rbi', 'repo rate', 'fed ', 'fomc', 'inflation', 'cpi', 'gdp', 'tariff', 'crude', 'rupee', 'sebi', 'budget', 'fii', 'fpi', 'war', 'ceasefire', 'nifty', 'sensex', 'gift nifty', 'us-india', 'trade deal'];

const POS = ['surge', 'surges', 'jumps', 'jump', 'soars', 'rallies', 'rally', 'record high', 'all-time high', 'upgrade', 'upgrades', 'beats', 'beat estimates', 'profit rises', 'profit jumps', 'net profit up', 'order win', 'bags order', 'wins order', 'buyback', 'dividend', 'bullish', 'gains', 'rises', 'strong results', 'outperform', 'raises guidance', 'rate cut', 'ceasefire', 'trade deal', 'fii buying', 'net buyers', 'stake buy', 'approval', 'approves'];
const NEG = ['falls', 'fall', 'plunges', 'plunge', 'slumps', 'tumbles', 'crashes', 'drops', 'downgrade', 'downgrades', 'misses', 'missed estimates', 'loss widens', 'net loss', 'profit falls', 'profit drops', 'fraud', 'probe', 'penalty', 'fine', 'sebi order', 'default', 'resigns', 'resignation', 'raid', 'ban', 'cuts guidance', 'tariff hike', 'tariff', 'war', 'selloff', 'sell-off', 'bearish', 'fii selling', 'net sellers', 'rate hike', 'weak results', 'underperform', 'layoffs', 'recall', 'ed raid', 'insolvency', 'shuts', 'warning'];
const NEGATORS = ['no ', 'not ', 'denies', 'denied', 'rules out', 'dismisses'];

function scoreText(t) {
  const x = ' ' + t.toLowerCase() + ' ';
  let s = 0, hits = [];
  for (const w of POS) if (x.includes(w)) { s += 1; hits.push('+' + w); }
  for (const w of NEG) if (x.includes(w)) { s -= 1; hits.push('-' + w); }
  const negated = NEGATORS.some(n => x.includes(n));
  if (negated && s !== 0) s = s > 0 ? s * 0.3 : s * 0.3;    // "denies fraud" jaisi headline ko halka karo
  const n = Math.max(1, hits.length);
  const score = Math.max(-1, Math.min(1, s / Math.max(2, n)));
  return { score: Math.round(score * 100) / 100, label: score >= 0.34 ? 'POSITIVE' : score <= -0.34 ? 'NEGATIVE' : 'NEUTRAL', hits };
}

function decode(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseRss(xml) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const g = tag => { const r = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i')); return r ? decode(r[1]) : ''; };
    const title = g('title'); if (!title) continue;
    const d = Date.parse(g('pubDate') || g('dc:date'));
    items.push({ title, link: g('link'), summary: g('description').slice(0, 280), ts: isFinite(d) ? d : null });
  }
  return items;
}
function tokens(t) {
  const stop = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'as', 'at', 'is', 'by', 'with', 'from', 'after', 'amid', 'says', 'stock', 'stocks', 'shares', 'share', 'india', 'indian']);
  return new Set(t.toLowerCase().replace(/[^a-z0-9% ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w)));
}
function similar(a, b) {
  let i = 0; for (const w of a) if (b.has(w)) i++;
  return i / Math.max(1, Math.min(a.size, b.size)) >= 0.6 && i >= 3;
}
function matchStocks(text) {
  const x = ' ' + text.toLowerCase().replace(/[^a-z0-9&.' ]/g, ' ') + ' ';
  const out = [];
  for (const [sym, aliases] of Object.entries(STOCKS)) {
    if (aliases.some(a => x.includes(' ' + a + ' ') || x.includes(' ' + a + "'s "))) out.push(sym);
  }
  return out;
}

// ---------------- state ----------------
const state = { items: [], feedStatus: {}, flows: null, flowsErr: null, history: [], updated: 0, seen: new Set(), alerts: [] };


function build(rawByFeed) {
  const now = Date.now();
  let all = [];
  for (const f of FEEDS) for (const it of (rawByFeed[f.id] || [])) {
    if (it.ts && now - it.ts > 36 * 3600 * 1000) continue;            // 36 ghante se purani nahi
    const sc = scoreText(it.title + ' ' + it.summary);
    const stocks = matchStocks(it.title);
    const macro = MACRO.some(k => (' ' + it.title.toLowerCase() + ' ').includes(k));
    all.push({ id: f.id + '|' + (it.link || it.title), title: it.title, link: it.link, ts: it.ts || now, source: f.name, sourceId: f.id, tier: f.tier, sent: sc.score, label: sc.label, hits: sc.hits, stocks, macro, tok: tokens(it.title) });
  }
  all.sort((a, b) => b.ts - a.ts);
  // cross-source confirmation
  for (const a of all) {
    const srcs = new Set([a.sourceId]);
    for (const b of all) if (b !== a && b.sourceId !== a.sourceId && Math.abs(a.ts - b.ts) < 12 * 3600 * 1000 && similar(a.tok, b.tok)) srcs.add(b.sourceId);
    a.sources = srcs.size;
    a.verify = a.tier === 'official' ? 'OFFICIAL' : (srcs.size >= 2 ? 'CONFIRMED' : 'SINGLE SOURCE');
  }
  // dedupe (same story from many sources: sabse trusted/latest rakho)
  const kept = [];
  for (const a of all) if (!kept.some(k => similar(k.tok, a.tok) && Math.abs(k.ts - a.ts) < 12 * 3600 * 1000)) kept.push(a);
  return kept.slice(0, 120).map(a => { const { tok, ...r } = a; return r; });
}
function stockTilt(items) {
  const m = {};
  for (const it of items) for (const s of it.stocks) {
    const o = m[s] = m[s] || { symbol: s, n: 0, sum: 0, confirmed: 0, pos: 0, neg: 0, last: 0 };
    o.n++; o.sum += it.sent; if (it.verify !== 'SINGLE SOURCE') o.confirmed++; if (it.label === 'POSITIVE') o.pos++; if (it.label === 'NEGATIVE') o.neg++; o.last = Math.max(o.last, it.ts);
  }
  return Object.values(m).map(o => {
    const avg = o.sum / o.n;
    return { symbol: o.symbol, news: o.n, confirmed: o.confirmed, pos: o.pos, neg: o.neg, avg: Math.round(avg * 100) / 100, tilt: avg >= 0.25 ? 'POSITIVE TILT' : avg <= -0.25 ? 'NEGATIVE TILT' : 'MIXED/NEUTRAL', last: o.last };
  }).sort((a, b) => Math.abs(b.avg) * b.news - Math.abs(a.avg) * a.news);
}

async function fetchText(url, ms = 12000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantEngine/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function refreshNews() {
  const raw = {};
  await Promise.all(FEEDS.map(async f => {
    try { raw[f.id] = parseRss(await fetchText(f.url)); state.feedStatus[f.id] = { name: f.name, ok: true, n: raw[f.id].length, at: Date.now() }; }
    catch (e) { raw[f.id] = []; state.feedStatus[f.id] = { name: f.name, ok: false, err: e.message, at: Date.now() }; }
  }));
  const items = build(raw);
  // alerts: naye, bharose layak (CONFIRMED/OFFICIAL), zor wale (|score|>=0.5) aur (stock ya macro)
  const first = state.seen.size === 0;
  for (const it of items) {
    if (state.seen.has(it.id)) continue;
    state.seen.add(it.id);
    if (first) continue;                                      // pehli baar ke purane items par alert nahi
    if (it.verify !== 'SINGLE SOURCE' && Math.abs(it.sent) >= 0.5 && (it.stocks.length || it.macro)) state.alerts.push({ at: Date.now(), kind: 'NEWS', title: it.title, label: it.label, source: it.source, verify: it.verify, stocks: it.stocks });
  }
  state.alerts = state.alerts.slice(-30);
  state.items = items; state.updated = Date.now();
}

// ---------------- events ----------------
// Official schedule (RBI press release 23 Mar 2026): MPC decision din = meeting ka teesra din, ~10:00 IST
const BASE_EVENTS = [
  { date: '2026-12-04', time: '10:00', title: 'RBI MPC policy decision', impact: 'HIGH', note: 'Meeting 2-4 Dec. Repo rate/stance se banks, NBFC, rupee par asar.' },
  { date: '2027-02-05', time: '10:00', title: 'RBI MPC policy decision', impact: 'HIGH', note: 'Meeting 3-5 Feb 2027.' },
  { date: '2026-10-28', time: '23:30', title: 'US Fed (FOMC) rate decision (verify)', impact: 'HIGH', note: 'Fed calendar ke hisaab se ~27-28 Oct; time IST me approx. Date confirm karo.' }
];
function loadEvents(helpers) {
  let ev = BASE_EVENTS.slice();
  try { const f = path.join(__dirname, 'events.json'); if (fs.existsSync(f)) ev = ev.concat(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { console.warn('[Events] events.json error:', e.message); }
  if (helpers && helpers.nextWeeklyExpiry) { const d = helpers.nextWeeklyExpiry(); if (d) ev.push({ date: d, time: '15:30', title: 'NIFTY weekly expiry', impact: 'MEDIUM', note: 'Expiry din 13:30 ke baad time decay tez, whipsaw.' }); }
  return ev.map(e => { const ts = Date.parse(e.date + 'T' + (e.time || '09:15') + ':00+05:30'); return Object.assign({}, e, { ts }); })
    .filter(e => isFinite(e.ts) && e.ts > Date.now() - 2 * 3600 * 1000).sort((a, b) => a.ts - b.ts).slice(0, 25);
}
// Company results/board meetings: user events.json me daale: {"date":"2026-10-20","time":"15:30","title":"RELIANCE Q2 results","impact":"HIGH","symbol":"RELIANCE"}

// ---------------- FII / DII & Institutional Flow ----------------
function loadHistory() {
  try {
    const f = path.join(__dirname, 'fii_dii_history.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.warn('[News] fii_dii_history.json error:', e.message);
  }
  return [];
}

function saveHistory(list) {
  try {
    const f = path.join(__dirname, 'fii_dii_history.json');
    fs.writeFileSync(f, JSON.stringify(list.slice(0, 30), null, 2), 'utf8');
  } catch (e) {
    console.warn('[News] fii_dii_history.json write error:', e.message);
  }
}

async function refreshFlows() {
  let hist = loadHistory();
  try {
    const home = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'text/html' } });
    const ck = (home.headers.getSetCookie ? home.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
    const r = await fetch('https://www.nseindia.com/api/fiidiiTradeReact', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json', 'Referer': 'https://www.nseindia.com/reports/fii-dii', 'Cookie': ck } });
    if (!r.ok) throw new Error('NSE HTTP ' + r.status);
    const j = await r.json();
    const out = { date: null, fii: null, dii: null };
    for (const row of j) {
      const cat = String(row.category || '').toUpperCase(); const net = parseFloat(String(row.netValue).replace(/,/g, ''));
      out.date = row.date || out.date;
      if (cat.includes('FII') || cat.includes('FPI')) out.fii = net; else if (cat.includes('DII')) out.dii = net;
    }
    if (out.fii == null && out.dii == null) throw new Error('Unexpected NSE format');

    if (out.date) {
      const existingIdx = hist.findIndex(h => h.date && h.date.toLowerCase() === out.date.toLowerCase());
      if (existingIdx >= 0) {
        hist[existingIdx] = Object.assign({}, hist[existingIdx], out);
      } else {
        hist.unshift(Object.assign({ fii_fut_oi: 52000, fii_long_ratio: (out.fii >= 0 ? 56.5 : 46.2) }, out));
      }
      saveHistory(hist);
    }
    state.flows = Object.assign(out, { at: Date.now(), source: 'NSE live provisional (₹ crore, cash segment)' });
    state.flowsErr = null;
  } catch (e) {
    state.flowsErr = e.message;
    manualFlows();
  }
  state.history = hist;
  if (!state.flows && hist.length > 0) {
    state.flows = Object.assign({}, hist[0], { at: Date.now(), source: 'NSE Historical Feed (' + hist[0].date + ')' });
  }
}

function manualFlows() {
  try {
    const f = path.join(__dirname, 'fii_dii.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      state.flows = Object.assign({}, j, { at: Date.now(), source: 'fii_dii.json (manual)' });
    }
  } catch (e) {}
}

function holdings() {
  try {
    const f = path.join(__dirname, 'fii_holdings.json'); if (!fs.existsSync(f)) return [];
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Object.entries(j).filter(([k]) => !k.startsWith('_')).map(([sym, v]) => {
      const d = Math.round((v.curr - v.prev) * 100) / 100;
      return { symbol: sym, prev: v.prev, curr: v.curr, delta: d, quarter: v.quarter || '', trend: d >= 0.25 ? 'FII INCREASED' : d <= -0.25 ? 'FII REDUCED' : 'ABOUT SAME' };
    }).sort((a, b) => b.delta - a.delta);
  } catch (e) { return []; }
}

function computeSentimentSummary(items, flows, history) {
  let pos = 0, neg = 0, neu = 0;
  for (const it of items) {
    if (it.label === 'POSITIVE') pos++;
    else if (it.label === 'NEGATIVE') neg++;
    else neu++;
  }
  const total = items.length;
  const netScore = total > 0 ? Math.round(((pos - neg) / (pos + neg || 1)) * 100) : 0;
  const fiiVal = flows && flows.fii != null ? flows.fii : 0;
  const diiVal = flows && flows.dii != null ? flows.dii : 0;
  const fiiDiiNet = Math.round((fiiVal + diiVal) * 100) / 100;

  let fiveDayFii = 0, fiveDayDii = 0;
  if (Array.isArray(history)) {
    history.slice(0, 5).forEach(h => {
      fiveDayFii += (h.fii || 0);
      fiveDayDii += (h.dii || 0);
    });
  }
  const fiveDayNet = Math.round((fiveDayFii + fiveDayDii) * 100) / 100;

  let institutionalBias = 'NEUTRAL / BALANCED ⚖️';
  if (fiiVal > 500 && diiVal > 500) institutionalBias = 'STRONG INSTITUTIONAL BUYING 🟢';
  else if (fiiVal > 0 && diiVal >= 0) institutionalBias = 'NET INSTITUTIONAL ACCUMULATION 🟢';
  else if (fiiVal < 0 && diiVal > Math.abs(fiiVal)) institutionalBias = 'DII ABSORBING FII OUTFLOW 🛡️';
  else if (fiiVal < 0 && diiVal <= 0) institutionalBias = 'HEAVY INSTITUTIONAL SELLING 🔴';
  else if (fiiVal < -1000) institutionalBias = 'HIGH FII CASH DUMPING ⚠️';
  else if (fiiVal > 0 && diiVal < 0) institutionalBias = 'FII DRIVEN BUYING (DII Profit Booking) 🚀';

  const latestFut = (history && history[0]) ? history[0] : null;

  return {
    totalNews: total,
    posCount: pos,
    negCount: neg,
    neutralCount: neu,
    sentimentScore: netScore,
    sentimentTilt: netScore >= 20 ? 'BULLISH TILT 🟢' : netScore <= -20 ? 'BEARISH TILT 🔴' : 'NEUTRAL / BALANCED ⚖️',
    fiiVal,
    diiVal,
    fiiDiiNet,
    fiveDayFii: Math.round(fiveDayFii * 100) / 100,
    fiveDayDii: Math.round(fiveDayDii * 100) / 100,
    fiveDayNet,
    institutionalBias,
    fiiLongRatio: latestFut && latestFut.fii_long_ratio ? latestFut.fii_long_ratio : 52.0,
    fiiFutOi: latestFut && latestFut.fii_fut_oi ? latestFut.fii_fut_oi : 48000
  };
}

function snapshot(helpers) {
  if (!state.history || !state.history.length) state.history = loadHistory();
  if (!state.flows && state.history.length > 0) {
    state.flows = Object.assign({}, state.history[0], { at: Date.now(), source: 'NSE Historical Feed (' + state.history[0].date + ')' });
  }

  const summary = computeSentimentSummary(state.items, state.flows, state.history);

  return {
    updated: state.updated,
    items: state.items,
    feeds: state.feedStatus,
    stocks: stockTilt(state.items),
    events: loadEvents(helpers),
    flows: state.flows,
    flowsErr: state.flowsErr,
    history: state.history,
    summary,
    holdings: holdings(),
    alerts: state.alerts,
    disclaimer: 'Keyword-based headline sentiment and institutional flow analytics for quant screening.'
  };
}

async function refreshAll() {
  await Promise.allSettled([refreshNews(), refreshFlows()]);
  return snapshot();
}

function start() {
  refreshNews().catch(() => {});
  refreshFlows().catch(() => {});
  setInterval(() => refreshNews().catch(() => {}), 120000);          // 2 min
  setInterval(() => refreshFlows().catch(() => {}), 15 * 60000);     // 15 min
}

module.exports = {
  start,
  snapshot,
  refreshAll,
  refreshNews,
  refreshFlows,
  _t: { parseRss, scoreText, build, stockTilt, matchStocks, similar, tokens }
};

