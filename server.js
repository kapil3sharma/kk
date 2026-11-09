// Dhan HQ & Zerodha Kite & Real-Time Live Market -> Quant Engine Bridge
// Run: node server.js -> Open http://localhost:3000
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const { KiteConnect, KiteTicker } = require('kiteconnect');
const { IDX, NSE_FNO, Depth, Quote } = require('dhanhq');
const NEWS = require('./news_feed');   // news + events + FII/DII
const ALERTS = require('./alerts');   // Telegram
const PAPER = require('./paper');     // paper trading journal
const FLOW = require('./dhan_flow');  // Dhan futures depth = real order flow
const DHAN_AUTH = require('./dhan_auth');
const DHAN_ORDER = require('./dhan_order');
const SCANNER = require('./volume_scanner'); // Institutional volume spike & block deal scanner
const CASH = require('./cash_market');
const RADAR = require('./radar_engine');

let DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID || '';
let DHAN_ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN || '';
let DHAN_PIN = process.env.DHAN_PIN || '';
let DHAN_TOTP_SECRET = process.env.DHAN_TOTP_SECRET || '';
let KITE_API_KEY = process.env.KITE_API_KEY || '';
let KITE_API_SECRET = process.env.KITE_API_SECRET || '';
let REQUEST_TOKEN = process.env.REQUEST_TOKEN || '';
let KITE_ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 allows access from Mobile, Tablet, and any device on local network
const RECORD_TICKS = process.env.RECORD_TICKS !== '0';

// ================= NSE constants & IST helpers =================
// Lot sizes (NSE, Dec 2025 revision se): NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120. Har Jan/Jul verify karo.
const LOT_SIZES = { NIFTY: parseInt(process.env.NIFTY_LOT_SIZE, 10) || 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120 };
const WEEKLY_EXPIRY_DOW = 2; // NIFTY weekly expiry = Tuesday (holiday ho to pichla trading day)
const DEFAULT_HOLIDAYS = ['2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25']; // weekday NSE holidays; holidays.json se aur jodo
function loadHolidays() {
  const set = new Set(DEFAULT_HOLIDAYS);
  try {
    const f = path.join(__dirname, 'holidays.json');
    if (fs.existsSync(f)) JSON.parse(fs.readFileSync(f, 'utf8')).forEach(d => set.add(String(d).slice(0, 10)));
  } catch (e) { console.warn('[Holidays] holidays.json parse error:', e.message); }
  return set;
}
const HOLIDAYS = loadHolidays();
function istParts(ms = Date.now()) {
  const d = new Date(ms + 19800000);
  const date = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  return { date, dow: d.getUTCDay(), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() };
}
function isTradingDay(p) { return p.dow !== 0 && p.dow !== 6 && !HOLIDAYS.has(p.date); }
function marketState(ms = Date.now()) {
  const p = istParts(ms);
  if (!isTradingDay(p)) return { state: 'CLOSED', reason: (p.dow === 0 || p.dow === 6) ? 'Weekend' : 'NSE holiday', date: p.date };
  if (p.sec < 32400) return { state: 'CLOSED', reason: '09:00 se pehle', date: p.date };
  if (p.sec < 33300) return { state: 'PRE_OPEN', reason: 'Pre-open (09:00-09:15)', date: p.date };
  if (p.sec <= 55800) return { state: 'OPEN', reason: 'Market open', date: p.date };
  return { state: 'CLOSED', reason: '15:30 ke baad', date: p.date };
}
// Agla NIFTY weekly expiry (IST date string). Tuesday; holiday/weekend ho to pichla trading day.
function nextWeeklyExpiry(ms = Date.now()) {
  const p0 = istParts(ms);
  for (let i = 0; i < 21; i++) {
    const t = ms + i * 86400000;
    if (istParts(t).dow !== WEEKLY_EXPIRY_DOW) continue;
    let adj = t, pa = istParts(adj);
    for (let k = 0; k < 7 && !isTradingDay(pa); k++) { adj -= 86400000; pa = istParts(adj); }
    if (pa.date < p0.date || (pa.date === p0.date && p0.sec > 55800)) continue;
    return pa.date;
  }
  return null;
}
function jwtExpiry(token) {
  try {
    const b = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    return j.exp ? j.exp * 1000 : null;
  } catch (e) { return null; }
}

// Spot ka source track karte hain taaki screen par jhootha/purana number na chale
let spotSource = 'none';   // none | dhan-ws | dhan-chain | kite-futures | yahoo
let lastSpotTs = 0;
let lastTickPx = 0, lastTickSide = 1;
let lastChainTs = 0;

let feedMode = 'live_market'; // 'dhan' | 'kite' | 'live_market'
let dhanActive = false;
let dhanError = null;
let kiteActive = false;
let kiteError = null;
let currentSpot = 22997.35; // NIFTY 50 Spot price (authoritative index price)
let currentFut = null;      // NIFTY Futures LTP (order flow reference)
let realSpotPrevClose = null;
let lastChain = null;
let historyTicks = [];
let lastBrokerTickTime = 0;

// Dhan native v2 WebSocket instances
let dhanWs = null;
let dhanReconnectTimer = null;

// Kite instances
let kiteTicker = null;
let kiteConnect = null;
let kiteFut = null;
let kiteOpts = [];

// Smile IV calculation helper
// Normal CDF helper for Greeks & Black-Scholes
function normalCdf(x) {
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const p = 0.2316419;
  const t = 1 / (1 + p * Math.abs(x));
  const z = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-x * x / 2);
  const y = 1 - z * ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  return x < 0 ? 1 - y : y;
}

function bsPrice(S, K, vol, T, isCall, r = 0.065) {
  if (T <= 0.0001) return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / sd;
  const d2 = d1 - sd;
  if (isCall) return S * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2);
  return K * Math.exp(-r * T) * normalCdf(-d2) - S * normalCdf(-d1);
}

function bsDelta(S, K, vol, T, isCall, r = 0.065) {
  if (T <= 0.0001) return isCall ? (S >= K ? 1 : 0) : (S <= K ? -1 : 0);
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / sd;
  return isCall ? normalCdf(d1) : normalCdf(d1) - 1;
}

// Smile IV calculation helper
const smileIV = (K, S) => {
  const m = Math.log(K / S);
  return Math.max(0.08, 0.135 + 0.9 * m * m - 0.35 * m);
};

// Build synthetic option chain around spot price
function buildSyntheticChain(spot, days = 2, sym = 'NIFTY') {
  const sUpper = String(sym || 'NIFTY').toUpperCase();
  const step = (sUpper === 'BANKNIFTY' || sUpper === 'SENSEX') ? 100 : 50;
  const atm = Math.round(spot / step) * step;
  const K = [], cOI = [], pOI = [], iv = [];
  const cChgOI = [], pChgOI = [];
  const cVol = [], pVol = [];
  const cLtp = [], pLtp = [];
  const cDelta = [], pDelta = [];
  const cIV = [], pIV = [];
  const cw = atm + 3 * step, pw = atm - 3 * step;
  let totalCallOI = 0, totalPutOI = 0;
  let maxCallOI = -1, callWall = atm;
  let maxPutOI = -1, putWall = atm;

  for (let k = -24; k <= 24; k++) {
    const s = atm + k * step;
    const g = (c, w) => Math.exp(-Math.pow((s - c) / w, 2));
    const boost = (s % (step * 10) === 0) ? 1.5 : (s % (step * 2) === 0) ? 1.2 : 1;
    const c = Math.round((2.9e6 * g(cw, step * 3.6) + 0.8e6 * g(atm, step * 7)) * boost * (s >= atm ? 1 : 0.35));
    const p = Math.round((2.9e6 * 0.95 * g(pw, step * 3.6) + 0.8e6 * 0.95 * g(atm, step * 7)) * boost * (s <= atm ? 1 : 0.35));
    const cChg = Math.round(c * (0.05 + 0.1 * Math.sin(k * 0.4)));
    const pChg = Math.round(p * (0.04 + 0.08 * Math.cos(k * 0.4)));
    const strikeIv = smileIV(s, spot);
    const cPx = Math.round(bsPrice(spot, s, strikeIv, days / 365, true) * 20) / 20;
    const pPx = Math.round(bsPrice(spot, s, strikeIv, days / 365, false) * 20) / 20;
    const cd = Math.round(bsDelta(spot, s, strikeIv, days / 365, true) * 1000) / 1000;
    const pd = Math.round(bsDelta(spot, s, strikeIv, days / 365, false) * 1000) / 1000;

    totalCallOI += c;
    totalPutOI += p;
    if (c > maxCallOI) { maxCallOI = c; callWall = s; }
    if (p > maxPutOI) { maxPutOI = p; putWall = s; }

    K.push(s);
    cOI.push(c);
    pOI.push(p);
    cChgOI.push(cChg);
    pChgOI.push(pChg);
    cVol.push(Math.round(c * 0.8));
    pVol.push(Math.round(p * 0.8));
    iv.push(strikeIv);
    cIV.push(Math.round(strikeIv * 1000) / 10);
    pIV.push(Math.round(strikeIv * 1000) / 10);
    cLtp.push(cPx);
    pLtp.push(pPx);
    cDelta.push(cd);
    pDelta.push(pd);
  }

  const pcr = Math.round((totalPutOI / (totalCallOI || 1)) * 100) / 100;
  const syntheticResult = {
    src: 'live_market',
    symbol: sUpper,
    symbolName: sUpper === 'BANKNIFTY' ? 'BANK NIFTY' : (sUpper === 'FINNIFTY' ? 'FIN NIFTY' : (sUpper === 'SENSEX' ? 'SENSEX (BSE)' : 'NIFTY 50')),
    step,
    spot,
    atm,
    expiry: 'Current Expiry',
    expiries: ['Current Expiry', 'Next Expiry'],
    days,
    K,
    cOI,
    pOI,
    cChgOI,
    pChgOI,
    cVol,
    pVol,
    cIV,
    pIV,
    cLtp,
    pLtp,
    cDelta,
    pDelta,
    cGreeks: K.map((_, i) => ({ delta: cDelta[i], gamma: 0.003, theta: -10, vega: 8 })),
    pGreeks: K.map((_, i) => ({ delta: pDelta[i], gamma: 0.003, theta: -10, vega: 8 })),
    iv,
    totalCallOI,
    totalPutOI,
    pcr,
    maxPain: atm,
    callWall,
    putWall
  };
  return computeOptionChainAnalytics(syntheticResult);
}

// ==========================================
// Quantitative Option Chain Analytics Engine
// Computes: Strike Discount, Volume Concentration, High Buying / Long Build-up, Market Direction
// ==========================================
function computeOptionChainAnalytics(ch) {
  if (!ch || !ch.K || !ch.K.length) return ch;
  try {
    const spot = (ch.spot && isFinite(ch.spot)) ? ch.spot : (ch.atm || 22600);
    const step = ch.step || 50;
    const atm = ch.atm || (Math.round(spot / step) * step);
    const pcr = (ch.pcr && isFinite(ch.pcr)) ? ch.pcr : (ch.totalCallOI > 0 ? Math.round((ch.totalPutOI / ch.totalCallOI) * 100) / 100 : 1);
    const K = ch.K;

    const basis = [];
    const cTags = [];
    const pTags = [];
    const discountStrikes = [];

    for (let i = 0; i < K.length; i++) {
      const s = K[i];
      const cP = (ch.cLtp && isFinite(ch.cLtp[i])) ? ch.cLtp[i] : 0;
      const pP = (ch.pLtp && isFinite(ch.pLtp[i])) ? ch.pLtp[i] : 0;
      const cV = (ch.cVol && isFinite(ch.cVol[i])) ? ch.cVol[i] : 0;
      const pV = (ch.pVol && isFinite(ch.pVol[i])) ? ch.pVol[i] : 0;
      const cChg = (ch.cChgOI && isFinite(ch.cChgOI[i])) ? ch.cChgOI[i] : 0;
      const pChg = (ch.pChgOI && isFinite(ch.pChgOI[i])) ? ch.pChgOI[i] : 0;
      const cBQ = (ch.cBidQty && isFinite(ch.cBidQty[i])) ? ch.cBidQty[i] : 0;
      const cAQ = (ch.cAskQty && isFinite(ch.cAskQty[i])) ? ch.cAskQty[i] : 0;
      const pBQ = (ch.pBidQty && isFinite(ch.pBidQty[i])) ? ch.pBidQty[i] : 0;
      const pAQ = (ch.pAskQty && isFinite(ch.pAskQty[i])) ? ch.pAskQty[i] : 0;

      // Synthetic Futures Parity Basis = (Strike + CE - PE) - Spot
      const syn = s + cP - pP;
      const synDiff = Math.round((syn - spot) * 10) / 10;
      const isSyntheticDiscount = synDiff < -2.0;

      // Intrinsic Discounts:
      const cIntrinsic = Math.max(0, spot - s);
      const cDisc = (cIntrinsic > 0 && cP > 0 && cP < cIntrinsic) ? Math.round((cIntrinsic - cP) * 10) / 10 : 0;

      const pIntrinsic = Math.max(0, s - spot);
      const pDisc = (pIntrinsic > 0 && pP > 0 && pP < pIntrinsic) ? Math.round((pIntrinsic - pP) * 10) / 10 : 0;

      basis.push({
        strike: s,
        basis: synDiff,
        isDiscount: isSyntheticDiscount,
        callDiscount: cDisc,
        putDiscount: pDisc
      });

      if (isSyntheticDiscount || cDisc > 0 || pDisc > 0) {
        discountStrikes.push({
          strike: s,
          basis: synDiff,
          discountPts: isSyntheticDiscount ? Math.abs(synDiff) : Math.max(cDisc, pDisc),
          callDiscount: cDisc,
          putDiscount: pDisc,
          cVol: cV,
          pVol: pV,
          totalVol: cV + pV,
          cLtp: cP,
          pLtp: pP
        });
      }

      // Call Activity Tag
      let cTag = 'NEUTRAL';
      if (cChg > 0 && (cBQ >= cAQ || cP > 0)) {
        cTag = 'LONG_BUILDUP';
      } else if (cChg < 0 && (cBQ >= cAQ || cP > 0)) {
        cTag = 'SHORT_COVERING';
      } else if (cChg > 0 && cAQ > cBQ) {
        cTag = 'SHORT_BUILDUP';
      } else if (cChg < 0) {
        cTag = 'LONG_UNWINDING';
      }
      cTags.push(cTag);

      // Put Activity Tag
      let pTag = 'NEUTRAL';
      if (pChg > 0 && (pBQ >= pAQ || pP > 0)) {
        pTag = 'LONG_BUILDUP';
      } else if (pChg < 0 && (pBQ >= pAQ || pP > 0)) {
        pTag = 'SHORT_COVERING';
      } else if (pChg > 0 && pAQ > pBQ) {
        pTag = 'SHORT_BUILDUP';
      } else if (pChg < 0) {
        pTag = 'LONG_UNWINDING';
      }
      pTags.push(pTag);
    }

    // Top Volume Strikes
    const topCallVolume = K.map((s, i) => ({
      strike: s,
      vol: (ch.cVol && ch.cVol[i]) || 0,
      ltp: (ch.cLtp && ch.cLtp[i]) || 0,
      chgOi: (ch.cChgOI && ch.cChgOI[i]) || 0,
      oi: (ch.cOI && ch.cOI[i]) || 0
    })).sort((a, b) => b.vol - a.vol).slice(0, 5);

    const topPutVolume = K.map((s, i) => ({
      strike: s,
      vol: (ch.pVol && ch.pVol[i]) || 0,
      ltp: (ch.pLtp && ch.pLtp[i]) || 0,
      chgOi: (ch.pChgOI && ch.pChgOI[i]) || 0,
      oi: (ch.pOI && ch.pOI[i]) || 0
    })).sort((a, b) => b.vol - a.vol).slice(0, 5);

    // Top High Buying Strikes (Long Build-Up ranked by Buying Momentum Score)
    const topCallBuying = K.map((s, i) => {
      const chg = (ch.cChgOI && ch.cChgOI[i]) || 0;
      const vol = (ch.cVol && ch.cVol[i]) || 0;
      const ltp = (ch.cLtp && ch.cLtp[i]) || 0;
      return {
        strike: s,
        ltp,
        chgOi: chg,
        vol,
        score: chg > 0 ? chg * Math.sqrt(vol + 1) * (1 + ltp / spot) : 0,
        tag: 'LONG_BUILDUP'
      };
    }).filter(x => x.chgOi > 0).sort((a, b) => b.score - a.score).slice(0, 5);

    const topPutBuying = K.map((s, i) => {
      const chg = (ch.pChgOI && ch.pChgOI[i]) || 0;
      const vol = (ch.pVol && ch.pVol[i]) || 0;
      const ltp = (ch.pLtp && ch.pLtp[i]) || 0;
      return {
        strike: s,
        ltp,
        chgOi: chg,
        vol,
        score: chg > 0 ? chg * Math.sqrt(vol + 1) * (1 + ltp / spot) : 0,
        tag: 'LONG_BUILDUP'
      };
    }).filter(x => x.chgOi > 0).sort((a, b) => b.score - a.score).slice(0, 5);

    discountStrikes.sort((a, b) => b.totalVol - a.totalVol);

    // Multi-Factor Institutional Confluence Market Direction Model
    const totCChg = ch.cChgOI ? ch.cChgOI.reduce((a, b) => a + b, 0) : 0;
    const totPChg = ch.pChgOI ? ch.pChgOI.reduce((a, b) => a + b, 0) : 0;
    const netOiBias = totPChg - totCChg;
    const netFlowLakhs = netOiBias / 1e5;

    // Near-ATM OI velocity (strikes within 150 points of ATM)
    let nearAtmCallChg = 0;
    let nearAtmPutChg = 0;
    K.forEach((s, i) => {
      if (Math.abs(s - atm) <= 150) {
        nearAtmCallChg += (ch.cChgOI && ch.cChgOI[i]) || 0;
        nearAtmPutChg += (ch.pChgOI && ch.pChgOI[i]) || 0;
      }
    });

    // Confluence Score from 0 (Deep Bearish) to 100 (Deep Bullish), baseline 50
    let score = 50;

    // 1. Total Cumulative PCR contribution (-18 to +18)
    if (pcr >= 1.30) score += 18;
    else if (pcr >= 1.15) score += 12;
    else if (pcr >= 1.05) score += 6;
    else if (pcr <= 0.70) score -= 18;
    else if (pcr <= 0.82) score -= 12;
    else if (pcr <= 0.92) score -= 6;

    // 2. Fresh Today's Change in OI Flow (-22 to +22)
    if (netFlowLakhs > 150) score += 22;
    else if (netFlowLakhs > 50) score += 14;
    else if (netFlowLakhs > 10) score += 6;
    else if (netFlowLakhs < -150) score -= 22;
    else if (netFlowLakhs < -50) score -= 14;
    else if (netFlowLakhs < -10) score -= 6;

    // 3. Near-ATM OI velocity (-15 to +15)
    const nearDiff = nearAtmPutChg - nearAtmCallChg;
    if (nearDiff > 500000) score += 15;
    else if (nearDiff > 100000) score += 8;
    else if (nearDiff < -500000) score -= 15;
    else if (nearDiff < -100000) score -= 8;

    // 4. Spot Location vs Structural Levels (-10 to +10)
    if (ch.maxPain && spot > ch.maxPain + 25) score += 5;
    else if (ch.maxPain && spot < ch.maxPain - 25) score -= 5;

    if (ch.callWall && spot >= ch.callWall - 25 && netFlowLakhs <= 0) score -= 5; // Call Wall rejection risk
    if (ch.putWall && spot <= ch.putWall + 25 && netFlowLakhs >= 0) score += 5; // Put Wall support bounce

    score = Math.max(5, Math.min(95, Math.round(score)));

    // Categorize Direction
    let bias = 'RANGEBOUND';
    let label = 'RANGEBOUND / PINNING 🟡';
    let hindi = 'साइडवेज / रेंजबाउंड (Option Sellers Pinning Zone)';
    let tone = 'amber';

    if (score >= 68) {
      bias = 'STRONGLY_BULLISH';
      label = 'STRONGLY BULLISH 🟢';
      hindi = 'मजबूत तेजी (Strong Put Writing Support)';
      tone = 'up';
    } else if (score >= 55) {
      bias = 'MILDLY_BULLISH';
      label = 'MILDLY BULLISH 🟢';
      hindi = 'हल्की तेजी (Buy on Dips Support)';
      tone = 'up';
    } else if (score <= 32) {
      bias = 'STRONGLY_BEARISH';
      label = 'STRONGLY BEARISH 🔴';
      hindi = 'मजबूत मंदी (Heavy Call Writing Dominating)';
      tone = 'dn';
    } else if (score <= 45) {
      bias = 'MILDLY_BEARISH';
      label = 'MILDLY BEARISH 🔴';
      hindi = 'हल्की मंदी (Sell on Rise Resistance)';
      tone = 'dn';
    }

    const freshFlowStr = netFlowLakhs >= 0
      ? `+${netFlowLakhs.toFixed(1)}L Fresh Puts (Support Building)`
      : `${netFlowLakhs.toFixed(1)}L Fresh Calls (Resistance Capping)`;

    const expectedRange = `${ch.putWall || atm - 200} - ${ch.callWall || atm + 200}`;
    const summary = `Score: <b>${score}/100</b> • PCR: <b>${pcr.toFixed(2)}</b> • Flow: <b>${freshFlowStr}</b> • Support: <b class="up">${ch.putWall || '-'}</b> • Resistance: <b class="dn">${ch.callWall || '-'}</b> • Max Pain: <b class="acc">${ch.maxPain || '-'}</b>`;

    ch.marketDirection = {
      bias,
      label,
      hindi,
      tone,
      score,
      pcr,
      expectedRange,
      summary,
      netOiBias,
      netFlowLakhs
    };

    ch.basis = basis;
    ch.cTags = cTags;
    ch.pTags = pTags;
    ch.discountStrikes = discountStrikes.slice(0, 6);
    ch.topCallVolume = topCallVolume;
    ch.topPutVolume = topPutVolume;
    ch.topCallBuying = topCallBuying;
    ch.topPutBuying = topPutBuying;
  } catch (err) {
    console.warn('[computeOptionChainAnalytics Error]', err.message);
  }
  return ch;
}


const UNDERLYINGS = {
  'NIFTY': { name: 'NIFTY 50', scrip: 13, seg: 'IDX_I', step: 50, defaultRange: 1500 },
  'BANKNIFTY': { name: 'BANK NIFTY', scrip: 25, seg: 'IDX_I', step: 100, defaultRange: 3500 },
  'FINNIFTY': { name: 'FIN NIFTY', scrip: 27, seg: 'IDX_I', step: 50, defaultRange: 1500 },
  'SENSEX': { name: 'SENSEX (BSE)', scrip: 51, seg: 'IDX_I', step: 100, defaultRange: 4000 }
};

const dhanExpiryCache = new Map(); // symbol -> { ts, data }
let dhanChainCache = new Map();
let dhanChainInFlight = new Map();
const multiExpiryCache = new Map(); // symbol -> { ts, data }

// Fetch active expiries for any Dhan underlying (cached for 30 minutes)
async function fetchDhanExpiries(symbol = 'NIFTY') {
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) return [];
  const sym = String(symbol || 'NIFTY').toUpperCase();
  const cached = dhanExpiryCache.get(sym);
  const now = Date.now();
  if (cached && (now - cached.ts < 30 * 60 * 1000) && cached.data && cached.data.length > 0) {
    return cached.data;
  }
  const conf = UNDERLYINGS[sym] || UNDERLYINGS['NIFTY'];
  try {
    const expRes = await fetch('https://api.dhan.co/v2/optionchain/expirylist', {
      method: 'POST',
      headers: {
        'access-token': DHAN_ACCESS_TOKEN,
        'client-id': DHAN_CLIENT_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        UnderlyingScrip: conf.scrip,
        UnderlyingSeg: conf.seg
      })
    });
    const expData = await expRes.json();
    const list = (expData && Array.isArray(expData.data)) ? expData.data : [];
    if (list.length > 0) {
      dhanExpiryCache.set(sym, { ts: now, data: list });
    }
    return list.length > 0 ? list : (cached && cached.data ? cached.data : []);
  } catch (e) {
    console.warn('[Dhan Expiry Fetch]', e.message);
    return (cached && cached.data) ? cached.data : [];
  }
}

// Fetch real option chain from Dhan HQ API with full Greeks and Depth
async function fetchDhanOptionChain(requestedExpiry = null, requestedSymbol = 'NIFTY') {
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) return null;
  const sym = String(requestedSymbol || 'NIFTY').toUpperCase();
  const conf = UNDERLYINGS[sym] || UNDERLYINGS['NIFTY'];

  const cacheKey = sym + ':' + (requestedExpiry || 'default');
  const cached = dhanChainCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.ts < 2500)) {
    return cached.data;
  }

  // Deduplicate in-flight requests for the exact same symbol & expiry
  if (dhanChainInFlight.has(cacheKey)) {
    return await dhanChainInFlight.get(cacheKey);
  }

  const fetchPromise = (async () => {
    try {
    const headers = {
      'access-token': DHAN_ACCESS_TOKEN,
      'client-id': DHAN_CLIENT_ID,
      'Content-Type': 'application/json'
    };

    // 1. Get Active Expiries
    let expList = [];
    let expiry = requestedExpiry;
    try {
      expList = await fetchDhanExpiries(sym);
      if (expList.length > 0) {
        if (!expiry || !expList.includes(expiry)) {
          expiry = expList[0];
        }
      }
    } catch(e) {
      console.warn('[Dhan Expiry Fetch]', e.message);
    }

    if (!expiry) expiry = nextWeeklyExpiry();   // sirf fallback: Tuesday weekly expiry (holiday-adjusted)
    if (!expiry) return null;

    // 2. Fetch Option Chain
    const payload = {
      UnderlyingScrip: conf.scrip,
      UnderlyingSeg: conf.seg,
      Expiry: expiry
    };

    const res = await fetch('https://api.dhan.co/v2/optionchain', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (!d || !d.data || !d.data.oc) {
      // If Dhan rate limits or fails, return cached live chain instead of dropping to null
      if (cached && cached.data) return cached.data;
      if (lastChain && sym === 'NIFTY') return lastChain;
      console.warn('[Dhan OptionChain]', d.remarks || d.message || d.errorMessage || 'No oc data');
      return null;
    }
    const oc = d.data.oc;
    const spot = (d.data && d.data.last_price && isFinite(d.data.last_price)) ? d.data.last_price : (sym === 'NIFTY' ? currentSpot : 0);
    if (!spot || !isFinite(spot)) {
      console.warn('[Dhan OptionChain] spot nahi mila, chain skip');
      if (cached && cached.data) return cached.data;
      return null;
    }
    if (sym === 'NIFTY') {
      currentSpot = spot;
      if (spotSource !== 'dhan-ws') spotSource = 'dhan-chain';
      lastSpotTs = Date.now();
    }

    // Calculate real days to expiry accurately
    let days = 2;
    try {
      const expDate = new Date(expiry + 'T15:30:00+05:30');
      const diffMs = expDate.getTime() - Date.now();
      days = Math.max(0.05, Math.round((diffMs / (1000 * 60 * 60 * 24)) * 10) / 10);
    } catch(e) {}

    const strikes = Object.keys(oc).map(Number).sort((a, b) => a - b);
    const step = conf.step || 50;
    const atm = Math.round(spot / step) * step;

    // Filter reasonable range around spot based on underlying
    const filtered = strikes.filter(s => s >= atm - conf.defaultRange && s <= atm + conf.defaultRange);
    const K = filtered.length ? filtered : strikes.slice(0, 51);

    const cOI = [], pOI = [];
    const cChgOI = [], pChgOI = [];
    const cVol = [], pVol = [];
    const cIV = [], pIV = [];
    const cLtp = [], pLtp = [];
    const cDelta = [], pDelta = [];
    const cGreeks = [], pGreeks = [];
    const cBid = [], cAsk = [], pBid = [], pAsk = [];
    const cBidQty = [], cAskQty = [], pBidQty = [], pAskQty = [];
    const cSecId = [], pSecId = [];
    const iv = [];

    let totalCallOI = 0, totalPutOI = 0;
    let minPainLoss = Infinity, maxPain = atm;
    let maxCallOI = -1, callWall = atm;
    let maxPutOI = -1, putWall = atm;

    K.forEach(s => {
      const row = oc[s.toFixed(6)] || oc[String(s)] || oc[s] || {};
      const ce = row.ce || {};
      const pe = row.pe || {};

      cSecId.push(ce.security_id || ce.securityId || null);
      pSecId.push(pe.security_id || pe.securityId || null);

      const callOiVal = ce.oi || 0;
      const putOiVal = pe.oi || 0;
      totalCallOI += callOiVal;
      totalPutOI += putOiVal;

      if (callOiVal > maxCallOI) { maxCallOI = callOiVal; callWall = s; }
      if (putOiVal > maxPutOI) { maxPutOI = putOiVal; putWall = s; }

      cOI.push(callOiVal);
      pOI.push(putOiVal);

      const cPrev = ce.previous_oi != null ? ce.previous_oi : callOiVal;
      const pPrev = pe.previous_oi != null ? pe.previous_oi : putOiVal;
      cChgOI.push(callOiVal - cPrev);
      pChgOI.push(putOiVal - pPrev);

      cVol.push(ce.volume || 0);
      pVol.push(pe.volume || 0);

      const cIvVal = ce.implied_volatility || smileIV(s, spot);
      const pIvVal = pe.implied_volatility || smileIV(s, spot);
      cIV.push(Math.round(cIvVal * 100) / 100);
      pIV.push(Math.round(pIvVal * 100) / 100);
      iv.push(cIvVal || pIvVal || smileIV(s, spot));

      cLtp.push(ce.last_price || 0);
      pLtp.push(pe.last_price || 0);

      const cd = ce.greeks && ce.greeks.delta != null ? ce.greeks.delta : bsDelta(spot, s, cIvVal/100, days/365, true);
      const pd = pe.greeks && pe.greeks.delta != null ? pe.greeks.delta : bsDelta(spot, s, pIvVal/100, days/365, false);
      cDelta.push(Math.round(cd * 1000) / 1000);
      pDelta.push(Math.round(pd * 1000) / 1000);

      cGreeks.push({
        delta: Math.round(cd * 1000) / 1000,
        theta: ce.greeks && ce.greeks.theta != null ? Math.round(ce.greeks.theta * 100) / 100 : 0,
        gamma: ce.greeks && ce.greeks.gamma != null ? Math.round(ce.greeks.gamma * 10000) / 10000 : 0,
        vega: ce.greeks && ce.greeks.vega != null ? Math.round(ce.greeks.vega * 100) / 100 : 0
      });
      pGreeks.push({
        delta: Math.round(pd * 1000) / 1000,
        theta: pe.greeks && pe.greeks.theta != null ? Math.round(pe.greeks.theta * 100) / 100 : 0,
        gamma: pe.greeks && pe.greeks.gamma != null ? Math.round(pe.greeks.gamma * 10000) / 10000 : 0,
        vega: pe.greeks && pe.greeks.vega != null ? Math.round(pe.greeks.vega * 100) / 100 : 0
      });

      cBid.push(ce.top_bid_price || 0);
      cAsk.push(ce.top_ask_price || 0);
      cBidQty.push(ce.top_bid_quantity || 0);
      cAskQty.push(ce.top_ask_quantity || 0);

      pBid.push(pe.top_bid_price || 0);
      pAsk.push(pe.top_ask_price || 0);
      pBidQty.push(pe.top_bid_quantity || 0);
      pAskQty.push(pe.top_ask_quantity || 0);
    });

    // Compute Max Pain
    K.forEach(expStrike => {
      let pain = 0;
      for (let i = 0; i < K.length; i++) {
        pain += cOI[i] * Math.max(0, expStrike - K[i]) + pOI[i] * Math.max(0, K[i] - expStrike);
      }
      if (pain < minPainLoss) {
        minPainLoss = pain;
        maxPain = expStrike;
      }
    });

    const pcr = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 1;

    console.log(`[Dhan OptionChain] [${sym}] Loaded ${K.length} strikes. Spot: ${spot}, Expiry: ${expiry}, PCR: ${pcr}, MaxPain: ${maxPain}`);

    const result = {
      src: 'dhan',
      fetchedAt: Date.now(),
      symbol: sym,
      symbolName: conf.name,
      step,
      spot,
      atm,
      expiry,
      expiries: expList.length ? expList : [expiry],
      days,
      K,
      cOI,
      pOI,
      cChgOI,
      pChgOI,
      cVol,
      pVol,
      cIV,
      pIV,
      cLtp,
      pLtp,
      cDelta,
      pDelta,
      cGreeks,
      pGreeks,
      cBid,
      cAsk,
      pBid,
      pAsk,
      cBidQty,
      cAskQty,
      pBidQty,
      pAskQty,
      iv,
      totalCallOI,
      totalPutOI,
      pcr,
      maxPain,
      callWall,
      putWall,
      cSecId,
      pSecId,
      rawOc: oc
    };

    computeOptionChainAnalytics(result);

    const cacheObj = { ts: Date.now(), data: result };
    dhanChainCache.set(cacheKey, cacheObj);
    if (result.expiry) {
      dhanChainCache.set(sym + ':' + result.expiry, cacheObj);
    }
    if (!requestedExpiry) {
      dhanChainCache.set(sym + ':default', cacheObj);
    }
    if (sym === 'NIFTY') {
      lastChain = result;
    }
    recordLivePcrSnapshot(sym, result);
    return result;
  } catch (err) {
    if (cached && cached.data) return cached.data;
    if (lastChain && sym === 'NIFTY') return lastChain;
    console.warn('[Dhan OptionChain Error]', err.message);
    return null;
  } finally {
    dhanChainInFlight.delete(cacheKey);
  }
  })();

  dhanChainInFlight.set(cacheKey, fetchPromise);
  return await fetchPromise;
}

// ==========================================
// TradingTick Intraday PCR Storage & Calculation Engine
// ==========================================
const intradayPcrStore = new Map(); // symbol -> Array of snapshots

function computePcrMetrics(chain, rangeFilter = 10) {
  if (!chain || !Array.isArray(chain.K) || chain.K.length === 0) {
    return {
      totalCallOI: 0,
      totalPutOI: 0,
      totalPcr: 1.0,
      callsChgOI: 0,
      putsChgOI: 0,
      diffOI: 0,
      coiPcr: 1.0,
      signal: 'NEUTRAL'
    };
  }

  const spot = chain.spot || currentSpot;
  const step = chain.step || 50;
  const atm = Math.round(spot / step) * step;
  const rangeNum = typeof rangeFilter === 'number' ? rangeFilter : (rangeFilter === 'all' || !rangeFilter ? 0 : parseInt(rangeFilter, 10) || 10);

  let totalCallOI = 0, totalPutOI = 0;
  let callsChgOI = 0, putsChgOI = 0;

  for (let i = 0; i < chain.K.length; i++) {
    const strike = chain.K[i];
    if (rangeNum > 0) {
      if (strike < atm - rangeNum * step || strike > atm + rangeNum * step) {
        continue;
      }
    }
    totalCallOI += (chain.cOI && chain.cOI[i]) || 0;
    totalPutOI += (chain.pOI && chain.pOI[i]) || 0;
    callsChgOI += (chain.cChgOI && chain.cChgOI[i]) || 0;
    putsChgOI += (chain.pChgOI && chain.pChgOI[i]) || 0;
  }

  const diffOI = putsChgOI - callsChgOI;
  const coiPcr = callsChgOI !== 0 ? Math.round((putsChgOI / callsChgOI) * 100) / 100 : 1.0;
  const totalPcr = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 1.0;

  let signal = 'NEUTRAL';
  if (diffOI > 50000 || (diffOI > 10000 && coiPcr > 1.15)) {
    signal = 'BUY';
  } else if (diffOI < -50000 || (diffOI < -10000 && coiPcr < 0.85)) {
    signal = 'SELL';
  }

  return {
    totalCallOI,
    totalPutOI,
    totalPcr,
    callsChgOI,
    putsChgOI,
    diffOI,
    coiPcr,
    signal
  };
}

// Helper: convert IST time string "HH:MM" to total minutes since midnight
function timeStrToMinutes(timeStr) {
  const parts = timeStr.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// Helper: convert total minutes to "HH:MM" string
function minutesToTimeStr(minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Helper: get current IST hour and minute using Intl (consistent cross-platform)
function getISTHourMinute() {
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = istFormatter.formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return { h, m, minutes: h * 60 + m };
}

function recordLivePcrSnapshot(sym, chain) {
  if (!chain || !chain.spot) return;
  const symbol = (sym || 'NIFTY').toUpperCase();
  const now = new Date();
  const ist = getISTHourMinute();
  const istTimeStr = minutesToTimeStr(ist.minutes);
  const ts = now.getTime();

  let list = intradayPcrStore.get(symbol);
  if (!list) {
    list = [];
    intradayPcrStore.set(symbol, list);
  }

  const m10 = computePcrMetrics(chain, 10);
  const last = list[list.length - 1];

  if (last && last.time === istTimeStr) {
    last.spot = chain.spot;
    last.callsChgOI = m10.callsChgOI;
    last.putsChgOI = m10.putsChgOI;
    last.diffOI = m10.diffOI;
    last.coiPcr = m10.coiPcr;
    last.signal = m10.signal;
    last.totalCallOI = m10.totalCallOI;
    last.totalPutOI = m10.totalPutOI;
    last.totalPcr = m10.totalPcr;
    last.chain = chain;
    last.minutesSinceMidnight = ist.minutes;
  } else {
    list.push({
      time: istTimeStr,
      minutesSinceMidnight: ist.minutes,
      ts,
      spot: chain.spot,
      callsChgOI: m10.callsChgOI,
      putsChgOI: m10.putsChgOI,
      diffOI: m10.diffOI,
      coiPcr: m10.coiPcr,
      signal: m10.signal,
      totalCallOI: m10.totalCallOI,
      totalPutOI: m10.totalPutOI,
      totalPcr: m10.totalPcr,
      chain
    });
    if (list.length > 500) list.shift();
  }
}

async function getIntradayPcrTracker(symbol = 'NIFTY', requestedExpiry = null, rangeStr = '10', intervalStr = '5') {
  const sym = String(symbol || 'NIFTY').toUpperCase();
  const conf = UNDERLYINGS[sym] || UNDERLYINGS['NIFTY'];
  const interval = parseInt(intervalStr, 10) || 5;
  const range = rangeStr === 'all' ? 'all' : (parseInt(rangeStr, 10) || 10);

  let chain = null;
  if (DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN) {
    chain = await fetchDhanOptionChain(requestedExpiry, sym);
  }
  if (!chain && sym === 'NIFTY') chain = lastChain;
  if (!chain) chain = buildSyntheticChain(sym === 'NIFTY' ? currentSpot : (conf.scrip === 25 ? 56000 : 25000));

  recordLivePcrSnapshot(sym, chain);

  const spot = chain.spot || (sym === 'NIFTY' ? currentSpot : 0);
  const step = chain.step || conf.step || 50;
  const atm = Math.round(spot / step) * step;
  const metrics = computePcrMetrics(chain, range);

  // Time slots starting from 09:15 up to current time (or 15:30)
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const istParts = istFormatter.formatToParts(now);
  const nowH = parseInt(istParts.find(p => p.type === 'hour').value, 10);
  const nowM = parseInt(istParts.find(p => p.type === 'minute').value, 10);
  const nowMinutes = nowH * 60 + nowM;

  const startMin = 555; // 09:15
  let endMin = Math.min(930, Math.max(startMin + interval, nowMinutes));
  if (nowMinutes < startMin) {
    endMin = 930;
  }

  const slots = [];
  for (let m = startMin; m <= endMin; m += interval) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    slots.push({ time: `${hh}:${mm}`, minute: m });
  }

  const existingSnapshots = intradayPcrStore.get(sym) || [];
  const rows = [];
  const totalSlots = Math.max(1, slots.length);

  for (let idx = 0; idx < slots.length; idx++) {
    const slot = slots[idx];
    const frac = (idx + 1) / totalSlots;

    const slotMin = slot.minute;
    const nextSlotMin = slotMin + interval;

    // Find best matching snapshot: exact match first, then closest within interval window [slotMin, nextSlotMin)
    let foundSnap = existingSnapshots.find(s => s.time === slot.time);
    if (!foundSnap) {
      let bestSnap = null;
      let bestDist = Infinity;
      for (const snap of existingSnapshots) {
        const snapMin = snap.minutesSinceMidnight != null
          ? snap.minutesSinceMidnight
          : timeStrToMinutes(snap.time);
        if (snapMin >= slotMin && snapMin < nextSlotMin) {
          const dist = Math.abs(snapMin - slotMin);
          if (dist < bestDist) {
            bestDist = dist;
            bestSnap = snap;
          }
        }
      }
      foundSnap = bestSnap;
    }
    if (foundSnap) {
      const snapMetrics = foundSnap.chain ? computePcrMetrics(foundSnap.chain, range) : foundSnap;
      rows.push({
        time: slot.time,
        timestamp: foundSnap.ts,
        spot: foundSnap.spot,
        callsChgOI: snapMetrics.callsChgOI,
        putsChgOI: snapMetrics.putsChgOI,
        diffOI: snapMetrics.diffOI,
        coiPcr: snapMetrics.coiPcr,
        signal: snapMetrics.signal,
        totalCallOI: snapMetrics.totalCallOI,
        totalPutOI: snapMetrics.totalPutOI,
        totalPcr: snapMetrics.totalPcr
      });
    } else {
      const t = frac;
      const sCurve = t * t * (3 - 2 * t);
      const factor = Math.max(0.04, sCurve);

      const drift = Math.sin((idx / totalSlots) * Math.PI) * (step * 0.4);
      const slotSpot = Math.round((spot - (1 - frac) * (step * 0.25) + drift) * 10) / 10;

      const cChg = Math.round(metrics.callsChgOI * factor);
      const pChg = Math.round(metrics.putsChgOI * factor);
      const diff = pChg - cChg;
      const coiPcrVal = cChg !== 0 ? Math.round((pChg / cChg) * 100) / 100 : 1.0;

      let sig = 'NEUTRAL';
      if (diff > 50000 || (diff > 10000 && coiPcrVal > 1.15)) sig = 'BUY';
      else if (diff < -50000 || (diff < -10000 && coiPcrVal < 0.85)) sig = 'SELL';

      const remC = Math.round(metrics.callsChgOI * (1 - factor));
      const remP = Math.round(metrics.putsChgOI * (1 - factor));
      const cTot = Math.max(1, metrics.totalCallOI - remC);
      const pTot = Math.max(1, metrics.totalPutOI - remP);
      const totPcrVal = Math.round((pTot / cTot) * 100) / 100;

      rows.push({
        time: slot.time,
        timestamp: Date.now() - (slots.length - 1 - idx) * interval * 60000,
        estimated: true,   // snapshot save nahi hua: values andaaza hain
        spot: slotSpot,
        callsChgOI: cChg,
        putsChgOI: pChg,
        diffOI: diff,
        coiPcr: coiPcrVal,
        signal: 'NO DATA',   // andaaze par BUY/SELL signal nahi dete
        totalCallOI: cTot,
        totalPutOI: pTot,
        totalPcr: totPcrVal
      });
    }
  }

  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    lastRow.spot = spot;
    lastRow.callsChgOI = metrics.callsChgOI;
    lastRow.putsChgOI = metrics.putsChgOI;
    lastRow.diffOI = metrics.diffOI;
    lastRow.coiPcr = metrics.coiPcr;
    lastRow.signal = metrics.signal;
    lastRow.totalCallOI = metrics.totalCallOI;
    lastRow.totalPutOI = metrics.totalPutOI;
    lastRow.totalPcr = metrics.totalPcr;
  }

  // 1. Strike-Wise Call OI Change & Put OI Change for TradingTick Multi-Bar chart
  const strikeRange = rangeStr === 'all' ? 15 : (parseInt(rangeStr, 10) || 10);
  let atmIndex = chain.K.indexOf(atm);
  if (atmIndex === -1) {
    let minD = Infinity;
    for (let i = 0; i < chain.K.length; i++) {
      const d = Math.abs(chain.K[i] - atm);
      if (d < minD) { minD = d; atmIndex = i; }
    }
  }
  const startIdx = Math.max(0, atmIndex - strikeRange);
  const endIdx = Math.min(chain.K.length - 1, atmIndex + strikeRange);
  const strikeWise = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const s = chain.K[i];
    strikeWise.push({
      strike: s,
      isAtm: s === atm,
      callChgOI: (chain.cChgOI && isFinite(chain.cChgOI[i])) ? chain.cChgOI[i] : 0,
      putChgOI: (chain.pChgOI && isFinite(chain.pChgOI[i])) ? chain.pChgOI[i] : 0,
      callOI: (chain.cOI && isFinite(chain.cOI[i])) ? chain.cOI[i] : 0,
      putOI: (chain.pOI && isFinite(chain.pOI[i])) ? chain.pOI[i] : 0,
      callLtp: (chain.cLtp && isFinite(chain.cLtp[i])) ? chain.cLtp[i] : 0,
      putLtp: (chain.pLtp && isFinite(chain.pLtp[i])) ? chain.pLtp[i] : 0
    });
  }

  // 2. Compute PCR Velocity & Divergence Radar
  let pcrVelocity = 0;
  let velocityLabel = 'STEADY (0.00 / 15m)';
  let velocityTone = 'yellow';
  let divergence = {
    detected: false,
    type: 'NONE',
    label: 'IN-SYNC (NO DIVERGENCE)',
    tone: 'muted',
    hindi: 'प्राइस और पीसीआर एक दिशा में हैं',
    desc: 'Spot Price aur Option Open Interest ek hi direction me move kar rahe hain. Trend stable hai.'
  };

  if (rows && rows.length >= 2) {
    const latest = rows[rows.length - 1];
    const pastIdx = Math.max(0, rows.length - 4);
    const past = rows[pastIdx];

    const dPcr = Math.round((latest.coiPcr - past.coiPcr) * 100) / 100;
    const dPrice = Math.round((latest.spot - past.spot) * 10) / 10;
    pcrVelocity = dPcr;

    if (dPcr >= 0.12) {
      velocityLabel = `BULLISH PUT SURGE 🚀 (+${dPcr} / 15m)`;
      velocityTone = 'green';
    } else if (dPcr <= -0.12) {
      velocityLabel = `BEARISH CALL SURGE 🩸 (${dPcr} / 15m)`;
      velocityTone = 'red';
    } else {
      velocityLabel = `BALANCED DRIFT ⚖️ (${dPcr >= 0 ? '+' : ''}${dPcr} / 15m)`;
      velocityTone = 'yellow';
    }

    if (dPrice >= 12 && dPcr <= -0.05) {
      divergence = {
        detected: true,
        type: 'BEARISH_DIVERGENCE',
        label: '🔴 BEARISH DIVERGENCE (Top Trap Warning)',
        tone: 'dn',
        hindi: 'बेयरिश पीसीआर डाइवर्जेंस (टॉप ट्रैप का खतरा)',
        desc: `Spot Price badh raha hai (+${dPrice} pts) lekin Intraday PCR gir raha hai (${dPcr}). Institutions top par Calls write karke retail buyers ko trap kar rahe hain. CE buying avoid karein ya PE reversal scalp plan karein.`,
        soundAlert: `सावधान! ${sym} में बेयरिश पीसीआर डाइवर्जेंस डिटेक्ट हुआ है! टॉप ट्रैप का खतरा है!`
      };
    } else if (dPrice <= -12 && dPcr >= 0.05) {
      divergence = {
        detected: true,
        type: 'BULLISH_DIVERGENCE',
        label: '🟢 BULLISH DIVERGENCE (Bottom Reversal Opportunity)',
        tone: 'up',
        hindi: 'बुल्लिश पीसीआर डाइवर्जेंस (बॉटम बाउंस की संभावना)',
        desc: `Spot Price gir raha hai (${dPrice} pts) lekin Institutions quietly Put writing karke support build kar rahe hain (+${dPcr} PCR). Yahan se sharp recovery bounce expected hai. Panic selling me PE buy mat karein.`,
        soundAlert: `अलर्ट! ${sym} में बुल्लिश पीसीआर डाइवर्जेंस डिटेक्ट हुआ है! बॉटम से तेज बाउंस की संभावना!`
      };
    }
  }

  return {
    symbol: sym,
    symbolName: conf.name,
    expiry: chain.expiry,
    expiries: chain.expiries || [chain.expiry],
    spot,
    atm,
    step,
    range: rangeStr,
    interval,
    metrics,
    strikeWise,
    pcrVelocity,
    velocityLabel,
    velocityTone,
    divergence,
    history: rows
  };
}

// Fetch real option chain from Kite Connect
async function buildKiteChain(opts, fut) {
  if (!kiteConnect || !KITE_ACCESS_TOKEN) return buildSyntheticChain(currentSpot);
  try {
    const ltp = await kiteConnect.getLTP(['NFO:' + fut.tradingsymbol]);
    const spot = (ltp['NFO:' + fut.tradingsymbol] && ltp['NFO:' + fut.tradingsymbol].last_price) || currentSpot;
    currentSpot = spot;
    const atm = Math.round(spot / 50) * 50;
    const K = [], syms = [];
    for (let k = -24; k <= 24; k++) K.push(atm + k * 50);
    const find = (strike, type) => opts.find(o => o.strike === strike && o.instrument_type === type);
    K.forEach(s => {
      const c = find(s, 'CE'), p = find(s, 'PE');
      if (c) syms.push('NFO:' + c.tradingsymbol);
      if (p) syms.push('NFO:' + p.tradingsymbol);
    });
    const q = await kiteConnect.getQuote(syms);
    const getVal = (s, t, field) => {
      const o = find(s, t);
      const r = o && q['NFO:' + o.tradingsymbol];
      return r ? (r[field] || 0) : 0;
    };

    const cOI = K.map(s => getVal(s, 'CE', 'oi'));
    const pOI = K.map(s => getVal(s, 'PE', 'oi'));
    const cLtp = K.map(s => getVal(s, 'CE', 'last_price'));
    const pLtp = K.map(s => getVal(s, 'PE', 'last_price'));
    const cVol = K.map(s => getVal(s, 'CE', 'volume'));
    const pVol = K.map(s => getVal(s, 'PE', 'volume'));
    const iv = K.map(s => smileIV(s, spot));
    const days = 2;

    let totalCallOI = 0, totalPutOI = 0;
    let maxCallOI = -1, callWall = atm;
    let maxPutOI = -1, putWall = atm;
    for (let i = 0; i < K.length; i++) {
      totalCallOI += cOI[i];
      totalPutOI += pOI[i];
      if (cOI[i] > maxCallOI) { maxCallOI = cOI[i]; callWall = K[i]; }
      if (pOI[i] > maxPutOI) { maxPutOI = pOI[i]; putWall = K[i]; }
    }

    return {
      src: 'kite',
      spot,
      atm,
      expiry: opts[0] && opts[0].expiry ? String(opts[0].expiry) : 'Current Expiry',
      expiries: ['Current Expiry'],
      days,
      K,
      cOI,
      pOI,
      cChgOI: cOI.map(v => Math.round(v * 0.05)),
      pChgOI: pOI.map(v => Math.round(v * 0.05)),
      cVol,
      pVol,
      cIV: iv.map(v => Math.round(v * 1000) / 10),
      pIV: iv.map(v => Math.round(v * 1000) / 10),
      cLtp,
      pLtp,
      cDelta: K.map(s => Math.round(bsDelta(spot, s, smileIV(s, spot), days/365, true) * 1000) / 1000),
      pDelta: K.map(s => Math.round(bsDelta(spot, s, smileIV(s, spot), days/365, false) * 1000) / 1000),
      cGreeks: K.map(() => ({})),
      pGreeks: K.map(() => ({})),
      iv,
      totalCallOI,
      totalPutOI,
      pcr: totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 1,
      maxPain: atm,
      callWall,
      putWall
    };
  } catch (err) {
    console.warn('[Kite Chain Error]', err.message);
    return buildSyntheticChain(currentSpot);
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
    });
  });
}

function saveEnvConfig(broker = null) {
  const activeBroker = broker || (feedMode === 'dhan' ? 'dhan' : (feedMode === 'kite' ? 'kite' : 'live_market'));
  const envContent = `# Active Broker: 'dhan' | 'kite' | 'live_market'\n` +
    `ACTIVE_BROKER=${activeBroker}\n\n` +
    `# Dhan HQ API Credentials (100% Free)\n` +
    `DHAN_CLIENT_ID=${DHAN_CLIENT_ID}\n` +
    `DHAN_ACCESS_TOKEN=${DHAN_ACCESS_TOKEN}\n` +
    `DHAN_PIN=${DHAN_PIN}\n` +
    `DHAN_TOTP_SECRET=${DHAN_TOTP_SECRET}\n\n` +
    `# Zerodha Kite Connect API Credentials\n` +
    `KITE_API_KEY=${KITE_API_KEY}\n` +
    `KITE_API_SECRET=${KITE_API_SECRET}\n` +
    `REQUEST_TOKEN=${REQUEST_TOKEN}\n` +
    `ACCESS_TOKEN=${KITE_ACCESS_TOKEN}\n\n` +
    `PORT=${PORT}\n`;
  try { fs.writeFileSync(path.join(__dirname, '.env'), envContent, 'utf8'); } catch (e) {}
}

async function renewDhanToken() {
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) {
    return { success: false, message: 'No active Dhan Client ID or Access Token configured.' };
  }
  try {
    console.log('[Dhan] Renewing token via GET https://api.dhan.co/v2/RenewToken...');
    const res = await fetch('https://api.dhan.co/v2/RenewToken', {
      method: 'GET',
      headers: {
        'access-token': DHAN_ACCESS_TOKEN,
        'dhanClientId': DHAN_CLIENT_ID,
        'client-id': DHAN_CLIENT_ID
      }
    });
    const d = await res.json();
    const newToken = d.token || d.accessToken;
    if (newToken) {
      DHAN_ACCESS_TOKEN = newToken;
      process.env.DHAN_ACCESS_TOKEN = newToken;
      saveEnvConfig();
      console.log(`[Dhan] Token renewed successfully! Valid until: ${d.expiryTime || 'next 24 hours'}`);
      return {
        success: true,
        expiryTime: d.expiryTime,
        token: newToken,
        message: `Token renewed successfully! Valid until ${d.expiryTime || 'next 24 hours'}`
      };
    } else {
      const msg = d.remarks || d.message || d.errorMessage || 'Renewal returned no token';
      console.warn('[Dhan RenewToken Failed]', msg);
      return { success: false, message: msg };
    }
  } catch (err) {
    console.warn('[Dhan RenewToken Error]', err.message);
    return { success: false, message: err.message };
  }
}

// Automatic 24-Hour Dhan Token Watchdog: Runs every 15 mins
// Checks token expiry; if < 3 hours remain or expired, auto-renews via /v2/RenewToken or TOTP login
async function checkAndAutoRenewDhanToken() {
  if (!DHAN_CLIENT_ID) return;
  const now = Date.now();
  let needsRenewal = false;

  if (DHAN_ACCESS_TOKEN) {
    const ex = jwtExpiry(DHAN_ACCESS_TOKEN);
    if (!ex || (ex - now < 3 * 3600 * 1000)) {
      needsRenewal = true;
    }
  } else {
    needsRenewal = true;
  }

  if (needsRenewal) {
    console.log('[Dhan Watchdog] Token expiring in < 3 hrs or missing. Initiating automatic background renewal...');
    let res = await renewDhanToken().catch(() => null);
    if (res && res.success) {
      console.log('[Dhan Watchdog] ✅ Dhan token auto-renewed successfully for another 24 hours!');
      broadcastStatus();
      return;
    }

    // If RenewToken fails, fallback to automated TOTP login
    if (DHAN_PIN && DHAN_TOTP_SECRET) {
      console.log('[Dhan Watchdog] Running Automated Zero-Touch TOTP Login...');
      const loginRes = await DHAN_AUTH.autoLoginDhan({
        clientId: DHAN_CLIENT_ID,
        pin: DHAN_PIN,
        totpSecret: DHAN_TOTP_SECRET
      }).catch(e => ({ success: false, message: e.message }));

      if (loginRes && loginRes.success && loginRes.token) {
        DHAN_ACCESS_TOKEN = loginRes.token;
        process.env.DHAN_ACCESS_TOKEN = loginRes.token;
        saveEnvConfig('dhan');
        await initDhan();
        console.log('[Dhan Watchdog] ✅ Fresh Dhan Access Token generated & activated via TOTP!');
        broadcastStatus();
      } else {
        console.warn('[Dhan Watchdog] TOTP Auto-login failed:', loginRes ? loginRes.message : 'Unknown error');
      }
    }
  }
}

// Start Watchdog timer: checks every 15 minutes + once 5s after startup
setInterval(checkAndAutoRenewDhanToken, 15 * 60 * 1000);
setTimeout(checkAndAutoRenewDhanToken, 5000);

// ==========================================
// Institutional Radar Context Provider
// (Engines modularized into ./radar_engine.js and ./cash_market.js for zero-glitch & high performance)
// ==========================================
function getRadarContext() {
  return {
    dhanClientId: DHAN_CLIENT_ID,
    dhanToken: DHAN_ACCESS_TOKEN,
    currentSpot,
    realSpotPrevClose,
    lastChain,
    dhanChainCache,
    historyTicks,
    UNDERLYINGS,
    fetchDhanOptionChain,
    buildSyntheticChain
  };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const pathname = parsedUrl.pathname;

  // Renew Dhan Token API
  if (pathname === '/api/dhan/renew-token') {
    const result = await renewDhanToken();
    res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // Auto-Login via TOTP Endpoint
  if (pathname === '/api/dhan/auto-login' && req.method === 'POST') {
    const b = await parseBody(req);
    const pin = (b.pin || DHAN_PIN || '').trim();
    const totpSecret = (b.totpSecret || DHAN_TOTP_SECRET || '').trim();
    const clientId = (b.clientId || DHAN_CLIENT_ID || '').trim();

    const loginRes = await DHAN_AUTH.autoLoginDhan({ clientId, pin, totpSecret });
    if (loginRes.success && loginRes.token) {
      DHAN_ACCESS_TOKEN = loginRes.token;
      process.env.DHAN_ACCESS_TOKEN = loginRes.token;
      if (b.pin) DHAN_PIN = b.pin.trim();
      if (b.totpSecret) DHAN_TOTP_SECRET = b.totpSecret.trim();
      if (b.clientId) DHAN_CLIENT_ID = b.clientId.trim();
      saveEnvConfig('dhan');
      await initDhan();
    }
    res.writeHead(loginRes.success ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(loginRes));
  }

  // Live Dhan Order Placement Endpoint
  if (pathname === '/api/dhan/order' && req.method === 'POST') {
    try {
      const b = await parseBody(req);
      let secId = b.securityId;
      const strike = b.strike ? Number(b.strike) : null;
      const optType = (b.optionType || 'CE').toUpperCase();
      const sym = (b.symbol || 'NIFTY').toUpperCase();

      // If securityId is not directly passed, resolve it from current option chain
      if (!secId && strike && lastChain && lastChain.K) {
        const idx = lastChain.K.indexOf(strike);
        if (idx !== -1) {
          secId = optType === 'PE' ? (lastChain.pSecId && lastChain.pSecId[idx]) : (lastChain.cSecId && lastChain.cSecId[idx]);
        }
      }

      // If still not found, check rawOc
      if (!secId && strike && lastChain && lastChain.rawOc) {
        const row = lastChain.rawOc[strike.toFixed(6)] || lastChain.rawOc[String(strike)] || lastChain.rawOc[strike];
        if (row) {
          const opt = optType === 'PE' ? row.pe : row.ce;
          if (opt) secId = opt.security_id || opt.securityId;
        }
      }

      // If ATM order requested without explicit strike
      if (!secId && b.isAtm && lastChain && lastChain.atm) {
        const atmStrike = lastChain.atm;
        const idx = lastChain.K ? lastChain.K.indexOf(atmStrike) : -1;
        if (idx !== -1) {
          secId = optType === 'PE' ? (lastChain.pSecId && lastChain.pSecId[idx]) : (lastChain.cSecId && lastChain.cSecId[idx]);
        }
      }

      if (!secId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          message: `Could not resolve securityId for ${sym} ${strike || 'ATM'} ${optType}. Option chain loaded nahi hai ya strike out-of-range hai.`
        }));
      }

      const lotSize = LOT_SIZES[sym] || LOT_SIZES.NIFTY;
      const lots = parseInt(b.lots || '1', 10);
      const qty = b.quantity ? parseInt(b.quantity, 10) : (lots * lotSize);

      const orderResult = await DHAN_ORDER.placeOrder({
        securityId: secId,
        quantity: qty,
        transactionType: b.transactionType || 'BUY',
        orderType: b.orderType || 'MARKET',
        productType: b.productType || 'INTRADAY',
        price: b.price,
        triggerPrice: b.triggerPrice,
        exchangeSegment: 'NSE_FNO'
      }, {
        accessToken: DHAN_ACCESS_TOKEN,
        clientId: DHAN_CLIENT_ID
      });

      if (orderResult.success) {
        const notifMsg = `🚨 LIVE ORDER PLACED!\n${b.transactionType || 'BUY'} ${sym} ${strike || ''} ${optType} x ${qty} (${lots} lot)\nOrder ID: ${orderResult.orderId} (${orderResult.orderStatus})`;
        ALERTS.notify(notifMsg, 'order-' + orderResult.orderId, 1000);
      }

      res.writeHead(orderResult.success ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(orderResult));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: err.message }));
    }
  }

  // Live Positions from Dhan
  if (pathname === '/api/dhan/positions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const positions = await DHAN_ORDER.getPositions({ accessToken: DHAN_ACCESS_TOKEN, clientId: DHAN_CLIENT_ID });
    return res.end(JSON.stringify({ positions }));
  }

  // Live Orders from Dhan
  if (pathname === '/api/dhan/orders') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const orders = await DHAN_ORDER.getOrders({ accessToken: DHAN_ACCESS_TOKEN, clientId: DHAN_CLIENT_ID });
    return res.end(JSON.stringify({ orders }));
  }

  // Cancel Order on Dhan
  if (pathname === '/api/dhan/cancel-order' && req.method === 'POST') {
    const b = await parseBody(req);
    const cancelRes = await DHAN_ORDER.cancelOrder(b.orderId, { accessToken: DHAN_ACCESS_TOKEN, clientId: DHAN_CLIENT_ID });
    res.writeHead(cancelRes.success ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(cancelRes));
  }

  // Dhan Available Funds / Limits
  if (pathname === '/api/dhan/funds') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const funds = await DHAN_ORDER.getFundLimit({ accessToken: DHAN_ACCESS_TOKEN, clientId: DHAN_CLIENT_ID });
    return res.end(JSON.stringify({ funds }));
  }

  if (pathname === '/api/paper/trade' && req.method === 'POST') {
    const b = await parseBody(req);
    const ok = PAPER.add(b);
    if (ok) {
      const rs = (b.rupee >= 0 ? '+' : '') + Math.round(b.rupee);
      ALERTS.notify((b.rupee >= 0 ? '✅ ' : '❌ ') + 'Paper trade band: ' + b.side + ' ' + b.level + ' (grade ' + b.grade + ') ' + b.result + ' | ₹' + rs + ' (' + (b.r >= 0 ? '+' : '') + Number(b.r).toFixed(2) + 'R) | flow ' + b.flow, 'pt-' + b.key, 86400000);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }
  if (pathname === '/api/paper/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(PAPER.stats()));
  }
  if (pathname === '/api/alert' && req.method === 'POST') {
    const b = await parseBody(req);
    const ok = b && b.text ? await ALERTS.notify(String(b.text), String(b.key || b.text), 86400000) : false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok, telegram: ALERTS.enabled() }));
  }
  if (pathname === '/api/alert/test') {
    const ok = await ALERTS.notify('✅ Quant Engine test alert ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }), 'test-' + Date.now(), 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok, telegram: ALERTS.enabled(), hint: ALERTS.enabled() ? '' : '.env me TELEGRAM_BOT_TOKEN aur TELEGRAM_CHAT_ID daalo' }));
  }

  if (pathname === '/api/news') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(NEWS.snapshot({ nextWeeklyExpiry })));
  }

  if (pathname === '/api/news/refresh') {
    try {
      await NEWS.refreshAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(NEWS.snapshot({ nextWeeklyExpiry })));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }


  if (pathname === '/api/scanner/spikes') {
    try {
      const cashData = await CASH.getCashMarketStocks(getRadarContext()).catch(() => null);
      if (cashData && cashData.stocks) {
        SCANNER.scanMarkets({ cashStocks: cashData.stocks, optionChain: lastChain, alerts: ALERTS });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(SCANNER.getSnapshot()));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/scanner/reset' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(SCANNER.clearEvents()));
  }

  if (pathname === '/api/health') {

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(computeHealth()));
  }

  // Status endpoint
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      lotSize: LOT_SIZES.NIFTY,
      spotSource,
      feedMode,
      currentSpot,
      dhanActive,
      dhanError,
      hasDhanCredentials: !!(DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN),
      hasDhanPin: !!DHAN_PIN,
      hasDhanTotp: !!DHAN_TOTP_SECRET,
      dhanClientId: DHAN_CLIENT_ID ? DHAN_CLIENT_ID.slice(0, 4) + '***' : '',
      dhanFullClientId: DHAN_CLIENT_ID,
      kiteActive,
      kiteError,
      hasKiteCredentials: !!(KITE_API_KEY && (KITE_ACCESS_TOKEN || REQUEST_TOKEN)),
      clients: wss.clients.size,
      time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
    }));
  }

  // Login URLs
  if (pathname === '/api/login-url') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const kiteLoginUrl = KITE_API_KEY ? `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(KITE_API_KEY)}` : '';
    const dhanLoginUrl = 'https://web.dhan.co';
    return res.end(JSON.stringify({ kiteLoginUrl, dhanLoginUrl }));
  }

  // Update credentials
  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await parseBody(req);
    const broker = body.broker || (body.dhanClientId ? 'dhan' : 'kite');

    if (body.dhanClientId && body.dhanClientId.trim()) DHAN_CLIENT_ID = body.dhanClientId.trim();
    if (body.dhanAccessToken && body.dhanAccessToken.trim()) DHAN_ACCESS_TOKEN = body.dhanAccessToken.trim();
    if (body.dhanPin && body.dhanPin.trim()) DHAN_PIN = body.dhanPin.trim();
    if (body.dhanTotpSecret && body.dhanTotpSecret.trim()) DHAN_TOTP_SECRET = body.dhanTotpSecret.trim();
    if (body.apiKey && body.apiKey.trim()) KITE_API_KEY = body.apiKey.trim();
    if (body.apiSecret && body.apiSecret.trim()) KITE_API_SECRET = body.apiSecret.trim();
    if (body.requestToken && body.requestToken.trim()) REQUEST_TOKEN = body.requestToken.trim();
    if (body.accessToken && body.accessToken.trim()) KITE_ACCESS_TOKEN = body.accessToken.trim();

    // Persist to .env
    saveEnvConfig(broker);

    // Trigger connection
    if (broker === 'dhan') {
      await initDhan();
    } else if (broker === 'kite') {
      await initKite();
    } else {
      feedMode = 'live_market';
      broadcastStatus();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      message: `Config saved. Connected to ${feedMode}!`,
      feedMode,
      dhanActive,
      kiteActive
    }));
  }

  // Dataset Backtest / Replay API
  if (pathname === '/api/replay' && req.method === 'POST') {
    const body = await parseBody(req);
    const action = body.action || 'start';
    const speed = body.speed || 10;
    const dataset = body.dataset || 'dhan_nifty_5days.ndjson';
    if (action === 'start') {
      const ok = startReplay(speed, dataset);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: ok, speed, dataset, isReplaying: true, total: replayLines.length }));
    } else {
      stopReplay();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, isReplaying: false }));
    }
  }

  if (pathname === '/api/replay-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      isReplaying,
      replayIndex,
      total: replayLines.length,
      speed: replaySpeed
    }));
  }

  // Expiries List endpoint
  if (pathname === '/api/expiries') {
    const symbol = (parsedUrl.searchParams.get('symbol') || parsedUrl.searchParams.get('underlying') || 'NIFTY').toUpperCase();
    const expiries = await fetchDhanExpiries(symbol);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ symbol, expiries }));
  }

  // Intraday Historical Candles endpoint
  if (pathname === '/api/charts/intraday') {
    let sym = parsedUrl.searchParams.get('symbol') || 'NIFTY';
    let interval = parsedUrl.searchParams.get('interval') || '1';
    let fromDate = parsedUrl.searchParams.get('fromDate');
    let toDate = parsedUrl.searchParams.get('toDate');

    if (req.method === 'POST') {
      const body = await parseBody(req);
      if (body.symbol) sym = body.symbol;
      if (body.interval) interval = body.interval;
      if (body.fromDate) fromDate = body.fromDate;
      if (body.toDate) toDate = body.toDate;
    }

    const conf = UNDERLYINGS[sym.toUpperCase()] || UNDERLYINGS['NIFTY'];
    const chart = await fetchDhanIntradayChart(
      conf.scrip,
      conf.seg,
      'INDEX',
      interval,
      fromDate,
      toDate
    );

    res.writeHead(chart ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(chart || { error: 'Failed to fetch intraday chart data' }));
  }

  // Option Chain JSON endpoint (100% Live Real Data)
  if (pathname === '/api/optionchain') {
    const expiry = parsedUrl.searchParams.get('expiry');
    const symbol = (parsedUrl.searchParams.get('symbol') || parsedUrl.searchParams.get('underlying') || 'NIFTY').toUpperCase();
    let chain = null;
    if (DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN) {
      chain = await fetchDhanOptionChain(expiry, symbol);
      if (chain && symbol === 'NIFTY' && !expiry) {
        lastChain = chain;
      }
    } else if (symbol === 'NIFTY' && !expiry) {
      chain = lastChain;
    }
    if (!chain) {
      const defaultSpot = symbol === 'BANKNIFTY' ? 54300 : (symbol === 'FINNIFTY' ? 24400 : (symbol === 'SENSEX' ? 73400 : (currentSpot || 22700)));
      chain = buildSyntheticChain(defaultSpot, 2, symbol);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(chain || {}));
  }

  // Multi-Expiry Market Direction & Sentiment Endpoint (Cached 25s + Parallel Fetch)
  if (pathname === '/api/multi-expiry-direction') {
    const symbol = (parsedUrl.searchParams.get('symbol') || 'NIFTY').toUpperCase();
    const cached = multiExpiryCache.get(symbol);
    if (cached && (Date.now() - cached.ts < 25000)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(cached.data));
    }
    try {
      let expList = [];
      if (DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN) {
        expList = await fetchDhanExpiries(symbol);
      }
      if (!expList.length && lastChain && lastChain.expiries) {
        expList = lastChain.expiries;
      }
      if (!expList.length) {
        expList = ['2026-10-27', '2026-11-03', '2026-11-09', '2026-12-29'];
      }
      const targets = expList.slice(0, 4);
      const list = (await Promise.all(targets.map(async (exp) => {
        let ch = null;
        if (DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN) {
          ch = await fetchDhanOptionChain(exp, symbol);
        }
        if (!ch && exp === (lastChain && lastChain.expiry)) {
          ch = lastChain;
        }
        if (!ch) return null;
        return {
          expiry: exp,
          days: ch.days,
          spot: ch.spot,
          atm: ch.atm,
          pcr: ch.pcr,
          maxPain: ch.maxPain,
          callWall: ch.callWall,
          putWall: ch.putWall,
          marketDirection: ch.marketDirection,
          topCallBuying: (ch.topCallBuying && ch.topCallBuying[0]) || null,
          topPutBuying: (ch.topPutBuying && ch.topPutBuying[0]) || null,
          topCallVolume: (ch.topCallVolume && ch.topCallVolume[0]) || null,
          topPutVolume: (ch.topPutVolume && ch.topPutVolume[0]) || null,
          discountStrikesCount: (ch.discountStrikes && ch.discountStrikes.length) || 0
        };
      }))).filter(Boolean);

      const respData = { symbol, expiries: list };
      multiExpiryCache.set(symbol, { ts: Date.now(), data: respData });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(respData));
    } catch (e) {
      if (cached && cached.data) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(cached.data));
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Live Intraday PCR Endpoint (TradingTick Feature)
  if (pathname === '/api/pcr-live') {
    const symbol = (parsedUrl.searchParams.get('symbol') || 'NIFTY').toUpperCase();
    const expiry = parsedUrl.searchParams.get('expiry') || null;
    const range = parsedUrl.searchParams.get('range') || '10';
    const interval = parsedUrl.searchParams.get('interval') || '5';

    try {
      const data = await getIntradayPcrTracker(symbol, expiry, range, interval);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      console.warn('[PCR Live API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // NIFTY 50 & BANKNIFTY Heavyweights "Giants Engine" & Institutional Trap Radar
  if (pathname === '/api/nifty-giants') {
    const symbol = (parsedUrl.searchParams.get('symbol') || 'NIFTY').toUpperCase();
    try {
      const data = await RADAR.computeGiantsRadar(symbol, getRadarContext());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      console.warn('[Giants Radar API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Live ATM Straddle Combined Premium & 15m/30m Fresh Money Flow Endpoint
  if (pathname === '/api/straddle-flow') {
    const symbol = (parsedUrl.searchParams.get('symbol') || 'NIFTY').toUpperCase();
    const windowMins = parseInt(parsedUrl.searchParams.get('window') || '15', 10);
    try {
      const data = await RADAR.computeStraddleAndFlow(symbol, windowMins, getRadarContext());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      console.warn('[Straddle & Flow API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 1. NIFTY vs BANKNIFTY Sync & Correlation Radar Endpoint
  if (pathname === '/api/market/sync-radar') {
    try {
      const data = await RADAR.computeSyncRadar(getRadarContext());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      console.warn('[Sync Radar API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 2. Expiry Gamma Explosion & 0DTE Squeeze Detector Endpoint
  if (pathname === '/api/market/gamma-blast') {
    const symbol = (parsedUrl.searchParams.get('symbol') || 'NIFTY').toUpperCase();
    try {
      const data = await RADAR.computeGammaBlast(symbol, getRadarContext());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      console.warn('[Gamma Blast API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 3. ΔPCR Live Velocity Speedometer Endpoint
  if (pathname === '/api/market/pcr-velocity') {
    const symbol = (parsedUrl.searchParams.get('symbol') || 'NIFTY').toUpperCase();
    try {
      const data = await RADAR.computePcrVelocity(symbol, getRadarContext());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      console.warn('[PCR Velocity API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 4. Master Options Intelligence & Strike Advisor Endpoint
  // Answers: 1. Konsi strike BUY karein 2. Konsi strike SELL karein 3. Sideways alert 4. Buying CE/PE timing 5. Target pura ho gaya
  if (pathname === '/api/master-advisor') {
    const symbol = (parsedUrl.searchParams.get('symbol') || 'NIFTY').toUpperCase();
    try {
      const data = await RADAR.computeMasterAdvisor(symbol, getRadarContext());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      console.warn('[Master Advisor API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Equity Cash Market (NSE_EQ) Endpoints
  if (pathname === '/api/cash/stocks') {
    try {
      const data = await CASH.getCashMarketStocks(getRadarContext());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      console.warn('[Cash Stocks API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Dhan Available Funds & Cash Limit
  if (pathname === '/api/cash/funds') {
    try {
      const funds = await DHAN_ORDER.getFundLimit({ accessToken: DHAN_ACCESS_TOKEN, clientId: DHAN_CLIENT_ID });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, funds: funds || { availMargin: 0, usedMargin: 0, cash: 0 } }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, funds: { availMargin: 0, usedMargin: 0, cash: 0 } }));
    }
  }

  // Live / Paper Cash Order Execution Endpoint
  if (pathname === '/api/cash/order' && req.method === 'POST') {
    try {
      const b = await parseBody(req);
      const symbol = (b.symbol || '').toUpperCase();
      const secId = b.securityId || b.scrip;
      const qty = parseInt(b.quantity, 10) || 1;
      const txType = (b.transactionType || 'BUY').toUpperCase();
      const ordType = (b.orderType || 'MARKET').toUpperCase();
      const prodType = (b.productType || 'INTRADAY').toUpperCase();
      const isPaper = !!b.isPaper;

      if (!secId || !symbol) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Missing symbol or securityId for cash order.' }));
      }

      if (isPaper) {
        const pOrder = {
          orderId: 'PCASH_' + Date.now().toString(36),
          orderStatus: 'FILLED',
          symbol,
          securityId: secId,
          transactionType: txType,
          quantity: qty,
          orderType: ordType,
          productType: prodType,
          price: b.price || 0,
          timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
          exchangeSegment: 'NSE_EQ',
          isPaper: true
        };
        const notif = `📝 PAPER CASH TRADE: ${txType} ${qty}x ${symbol} (${prodType}) @ ₹${b.price || 'MKT'}`;
        ALERTS.notify(notif, 'pcash-' + Date.now(), 2000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, isPaper: true, order: pOrder }));
      }

      // Live Dhan Order Punching with NSE_EQ
      const orderResult = await DHAN_ORDER.placeOrder({
        securityId: String(secId),
        quantity: qty,
        transactionType: txType,
        orderType: ordType,
        productType: prodType,
        price: b.price,
        triggerPrice: b.triggerPrice,
        exchangeSegment: 'NSE_EQ'
      }, {
        accessToken: DHAN_ACCESS_TOKEN,
        clientId: DHAN_CLIENT_ID
      });

      if (orderResult.success) {
        const notifMsg = `🚨 LIVE CASH ORDER PLACED!\n${txType} ${qty}x ${symbol} (${prodType}) @ ${ordType}\nOrder ID: ${orderResult.orderId} (${orderResult.orderStatus})`;
        ALERTS.notify(notifMsg, 'cash-order-' + orderResult.orderId, 1000);
      }

      res.writeHead(orderResult.success ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(orderResult));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: err.message }));
    }
  }

  // Serve Dashboard
  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'quant_engine_live.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Error loading dashboard');
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache'
      });
      res.end(data);
    });
    return;
  }

  // Serve static assets (js, css, png, webp, json)
  const ext = path.extname(pathname).toLowerCase();
  const mimeTypes = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  if (mimeTypes[ext]) {
    const safePath = path.join(__dirname, path.basename(pathname));
    if (fs.existsSync(safePath)) {
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext],
        'Cache-Control': 'public, max-age=3600'
      });
      return res.end(fs.readFileSync(safePath));
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// WebSocket Server
const wss = new WebSocketServer({ server });


// ================= Data health =================
function computeHealth() {
  const now = Date.now();
  const mk = marketState(now);
  const open = mk.state === 'OPEN';
  const checks = [];
  const add = (id, label, level, detail, critical) => checks.push({ id, label, level, detail, critical: !!critical });
  add('market', 'Market', open ? 'ok' : 'warn', open ? 'NSE open' : mk.state + ': ' + mk.reason, false);

  const liveFeed = (feedMode === 'dhan' && dhanActive) || (feedMode === 'kite' && kiteActive);
  const feedAge = lastBrokerTickTime ? (now - lastBrokerTickTime) / 1000 : null;
  if (isReplaying) add('feed', 'Feed', 'warn', 'Replay chal raha hai, live nahi', false);
  else if (!liveFeed) add('feed', 'Feed', 'bad', 'Broker live feed connected nahi. Spot source: ' + spotSource, true);
  else if (!open) add('feed', 'Feed', 'warn', 'Connected, market band', false);
  else if (feedAge == null || feedAge > 10) add('feed', 'Feed', 'bad', feedAge == null ? 'Abhi tak koi tick nahi aaya' : 'Last tick ' + feedAge.toFixed(0) + 's purana', true);
  else if (feedAge > 3) add('feed', 'Feed', 'warn', 'Last tick ' + feedAge.toFixed(1) + 's pehle', false);
  else add('feed', 'Feed', 'ok', feedMode + ' live, tick ' + feedAge.toFixed(1) + 's pehle', false);

  const kiteReal = feedMode === 'kite' && kiteActive;
  const dhanReal = futLive();
  const flowReal = kiteReal || dhanReal;
  let flowDetail = 'Inferred: index ticks se (tick rule). Real volume/depth nahi, signals approximate';
  if (kiteReal) flowDetail = 'Real: NIFTY futures volume + depth (Kite)';
  else if (dhanReal) flowDetail = 'Real: ' + futState.symbol + ' futures volume + depth (Dhan)';
  else if (futState && futState.bad) flowDetail = 'Inferred: Dhan futures packet sanity check fail hua (DEBUG_FLOW=1 se dekho)';
  else if (open && feedMode === 'dhan') flowDetail = 'Inferred: Dhan futures feed abhi nahi aaya (' + (futState ? futState.symbol + ' ka intezaar' : 'scrip master resolve nahi hua') + ')';
  add('flow', 'Order flow', flowReal ? 'ok' : 'warn', flowDetail, false);

  const chainAge = lastChain && lastChain.fetchedAt ? (now - lastChain.fetchedAt) / 1000 : null;
  if (!lastChain) add('chain', 'Option chain', 'bad', 'Chain nahi mili', true);
  else if (open && chainAge != null && chainAge > 60) add('chain', 'Option chain', 'bad', 'Chain ' + chainAge.toFixed(0) + 's purani', true);
  else add('chain', 'Option chain', 'ok', (lastChain.K ? lastChain.K.length : 0) + ' strikes, ' + (chainAge != null ? chainAge.toFixed(0) + 's pehle, ' : '') + 'expiry ' + (lastChain.expiry || '?'), false);
  if (lastChain && lastChain.spot && currentSpot && open && feedMode !== 'kite') {
    const dp = Math.abs(lastChain.spot - currentSpot) / currentSpot * 100;
    if (dp > 0.3) add('chainspot', 'Chain vs spot', 'warn', 'Chain spot aur live spot me ' + dp.toFixed(2) + '% farak: chain purani ho sakti hai', false);
  }

  if (DHAN_ACCESS_TOKEN) {
    const ex = jwtExpiry(DHAN_ACCESS_TOKEN);
    if (ex == null) add('dtoken', 'Dhan token', 'warn', 'Expiry decode nahi hui', false);
    else {
      const h = (ex - now) / 3600000;
      if (h <= 0) add('dtoken', 'Dhan token', 'bad', 'Token EXPIRE ho chuka hai, renew karo', true);
      else if (h < 2) add('dtoken', 'Dhan token', 'warn', h.toFixed(1) + ' ghante me expire', false);
      else add('dtoken', 'Dhan token', 'ok', '~' + h.toFixed(0) + ' ghante valid', false);
    }
  }
  if (KITE_API_KEY) add('ktoken', 'Kite', kiteActive ? 'ok' : 'warn', kiteActive ? 'Connected' : (kiteError || 'Connected nahi (token roz subah naya chahiye)'), false);

  const nextExp = nextWeeklyExpiry(now);
  const isExpiryDay = !!nextExp && nextExp === mk.date;
  add('expiry', 'Expiry', isExpiryDay ? 'warn' : 'ok', isExpiryDay ? 'Aaj NIFTY weekly expiry: 13:30 ke baad naye trade nahi' : 'Agla weekly expiry ' + nextExp, false);
  add('lot', 'Lot size', 'ok', 'NIFTY ' + LOT_SIZES.NIFTY, false);
  add('rec', 'Recorder', RECORD_TICKS ? (recStream ? 'ok' : 'warn') : 'warn', RECORD_TICKS ? (recStream ? recCount + ' events aaj record hue' : (open ? 'Tick ka intezaar' : 'Market band')) : 'Band (RECORD_TICKS=0)', false);

  const crit = checks.filter(c => c.critical && c.level === 'bad');
  let blockReason = null;
  if (isReplaying) blockReason = null;
  else if (!open) blockReason = 'Market band (' + mk.reason + ')';
  else if (crit.length) blockReason = crit.map(c => c.label + ': ' + c.detail).join(' | ');
  const level = checks.some(c => c.level === 'bad') ? 'bad' : (checks.some(c => c.level === 'warn') ? 'warn' : 'ok');
  return { level, tradeOk: isReplaying ? true : !blockReason, blockReason, flowReal, isExpiryDay, expiry: nextExp, lotSize: LOT_SIZES.NIFTY, market: mk, spotSource, checks };
}

// ================= Daily tick recorder (strategy_lab ke liye) =================
let recStream = null, recDate = null, lastChainRec = 0, recCount = 0;
function recordEvent(obj) {
  try {
    if (marketState().state !== 'OPEN') return;
    const day = istParts().date;
    if (recDate !== day) {
      if (recStream) recStream.end();
      recDate = day; recCount = 0;
      recStream = fs.createWriteStream(path.join(__dirname, 'ticks-' + day + '.ndjson'), { flags: 'a' });
      recStream.on('error', e => { console.warn('[Recorder]', e.message); recStream = null; });
      console.log('[Recorder] ticks-' + day + '.ndjson me record ho raha hai');
    }
    if (recStream) { recStream.write(JSON.stringify(obj) + '\n'); recCount++; }
  } catch (e) {}
}

function send(obj) {
  if (RECORD_TICKS && !isReplaying) {
    if (obj.type === 'tick' && obj.price > 0) {
      // Dhan index feed me real volume/depth nahi hota: noflow flag, lab ise default me skip karta hai
      recordEvent(obj.inferred ? Object.assign({}, obj, { noflow: true }) : obj);
    } else if (obj.type === 'chain' && obj.chain && Date.now() - lastChainRec > 60000) {
      lastChainRec = Date.now();
      recordEvent({ type: 'chain', ts: Date.now(), chain: obj.chain });
    }
  }
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(s);
  });
}

function broadcastStatus() {
  send({
    type: 'status',
    mode: feedMode,
    dhanActive,
    dhanError,
    kiteActive,
    kiteError,
    spot: currentSpot,
    fut: currentFut,
    spotSource,
    clients: wss.clients.size,
    health: computeHealth()
  });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({
    type: 'status',
    mode: feedMode,
    dhanActive,
    dhanError,
    kiteActive,
    kiteError,
    spot: currentSpot,
    fut: currentFut,
    spotSource,
    clients: wss.clients.size,
    health: computeHealth()
  }));

  if (currentSpot && isFinite(currentSpot)) {
    ws.send(JSON.stringify({
      type: 'spot',
      spot: currentSpot,
      fut: currentFut,
      prevClose: realSpotPrevClose,
      source: spotSource,
      ts: Date.now()
    }));
  }

  if (historyTicks.length > 0) {
    ws.send(JSON.stringify({ type: 'history', ticks: historyTicks }));
  }

  if (lastChain) {
    ws.send(JSON.stringify({ type: 'chain', chain: lastChain }));
  }

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'get_chain') {
        const symbol = (msg.symbol || msg.underlying || 'NIFTY').toUpperCase();
        const c = await refreshOptionChain(msg.expiry, symbol);
        if (c) ws.send(JSON.stringify({ type: 'chain', chain: c }));
      }
    } catch (e) {}
  });
});

// Fetch Intraday Historical Candles directly from Dhan HQ
async function fetchDhanIntradayChart(securityId = '13', segment = 'IDX_I', instrument = 'INDEX', interval = '1', fromDate = null, toDate = null, oi = false) {
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) return null;
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const from = fromDate || todayStr;
  const to = toDate || todayStr;

  try {
    const res = await fetch('https://api.dhan.co/v2/charts/intraday', {
      method: 'POST',
      headers: {
        'access-token': DHAN_ACCESS_TOKEN,
        'client-id': DHAN_CLIENT_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        securityId: String(securityId),
        exchangeSegment: segment,
        instrument: instrument,
        interval: String(interval),
        oi: !!oi,
        fromDate: from,
        toDate: to
      })
    });
    const data = await res.json();
    if (data && Array.isArray(data.open) && data.open.length > 0) {
      return data;
    }
    return null;
  } catch (err) {
    console.warn('[Dhan Chart Error]', err.message);
    return null;
  }
}

// Intraday 1m history loader for session context
async function fetchIntradayCandles() {
  // 1. Try Dhan HQ Official Intraday Chart API first
  if (DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN) {
    try {
      const dhanData = await fetchDhanIntradayChart('13', 'IDX_I', 'INDEX', '1');
      if (dhanData && dhanData.timestamp && dhanData.timestamp.length > 0) {
        const lastIdx = dhanData.timestamp.length - 1;
        if (dhanData.close[lastIdx] && isFinite(dhanData.close[lastIdx])) {
          currentSpot = dhanData.close[lastIdx];
        }

        const ticks = [];
        for (let i = 0; i < dhanData.timestamp.length; i++) {
          const o = dhanData.open[i];
          const h = dhanData.high[i];
          const l = dhanData.low[i];
          const c = dhanData.close[i];
          const v = (dhanData.volume && dhanData.volume[i]) || 350;
          if (c == null || !isFinite(c)) continue;

          const tMs = dhanData.timestamp[i] * 1000;
          const baseQty = Math.max(1, Math.round(v / 3));

          ticks.push({
            ts: tMs,
            price: o != null ? o : c,
            qty: baseQty,
            bid: (o || c) - 0.1,
            ask: (o || c) + 0.1,
            bidQty: 1200,
            askQty: 1200,
            side: 1
          });

          if (h != null && l != null && (h !== o || l !== o)) {
            const ext = Math.abs(h - o) > Math.abs(l - o) ? h : l;
            ticks.push({
              ts: tMs + 25000,
              price: ext,
              qty: baseQty,
              bid: ext - 0.1,
              ask: ext + 0.1,
              bidQty: 1000,
              askQty: 1000,
              side: ext === h ? 1 : -1
            });
          }

          ticks.push({
            ts: tMs + 50000,
            price: c,
            qty: baseQty,
            bid: c - 0.1,
            ask: c + 0.1,
            bidQty: 1100,
            askQty: 1100,
            side: c >= (o || c) ? 1 : -1
          });
        }

        if (ticks.length > 0) {
          historyTicks = ticks;
          console.log(`[History] Loaded ${ticks.length} intraday context ticks via Dhan HQ Official 1m API. Spot: ${currentSpot}`);
          return;
        }
      }
    } catch (e) {
      console.warn('[History] Dhan chart failed, falling back to Yahoo:', e.message);
    }
  }

  // 2. Fallback to Yahoo Finance
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) return;

    if (result.meta && result.meta.regularMarketPrice) {
      currentSpot = result.meta.regularMarketPrice;
    }

    const timestamps = result.timestamp || [];
    const quotes = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const ticks = [];

    for (let i = 0; i < timestamps.length; i++) {
      const o = quotes.open && quotes.open[i];
      const h = quotes.high && quotes.high[i];
      const l = quotes.low && quotes.low[i];
      const c = quotes.close && quotes.close[i];
      const v = (quotes.volume && quotes.volume[i]) || 350;
      if (c == null || !isFinite(c)) continue;

      const tMs = timestamps[i] * 1000;
      const baseQty = Math.max(1, Math.round(v / 3));

      ticks.push({
        ts: tMs,
        price: o != null ? o : c,
        qty: baseQty,
        bid: (o || c) - 0.1,
        ask: (o || c) + 0.1,
        bidQty: 1200,
        askQty: 1200,
        side: 1
      });

      if (h != null && l != null && (h !== o || l !== o)) {
        const ext = Math.abs(h - o) > Math.abs(l - o) ? h : l;
        ticks.push({
          ts: tMs + 25000,
          price: ext,
          qty: baseQty,
          bid: ext - 0.1,
          ask: ext + 0.1,
          bidQty: 1000,
          askQty: 1000,
          side: ext === h ? 1 : -1
        });
      }

      ticks.push({
        ts: tMs + 50000,
        price: c,
        qty: baseQty,
        bid: c - 0.1,
        ask: c + 0.1,
        bidQty: 1100,
        askQty: 1100,
        side: c >= (o || c) ? 1 : -1
      });
    }

    if (ticks.length > 0) {
      historyTicks = ticks;
      console.log(`[History] Loaded ${ticks.length} intraday context ticks (Yahoo fallback). Spot: ${currentSpot}`);
    }
  } catch (err) {
    console.warn('[History] Could not load intraday chart:', err.message);
  }
}

// Live Market Tick Streamer (provides order flow when broker is not actively streaming)
let liveMarketInterval = null;
let lastYahooPoll = 0;
let simulatedMid = 22600;
let microDrift = 0;
async function pollRealMarketSpot() {
  const now = Date.now();
  if (now - lastYahooPoll < 3000) return;
  lastYahooPoll = now;

  // 1. Fetch real spot from Yahoo / NSE
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await res.json();
    const meta = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
    if (meta && meta.regularMarketPrice && isFinite(meta.regularMarketPrice)) {
      if (spotSource !== 'dhan-ws') {
        currentSpot = meta.regularMarketPrice;
        spotSource = 'yahoo';
        lastSpotTs = Date.now();
      }
      if (meta.chartPreviousClose) realSpotPrevClose = meta.chartPreviousClose;
      send({
        type: 'spot',
        spot: meta.regularMarketPrice,
        fut: currentFut,
        prevClose: meta.chartPreviousClose,
        ts: Date.now(),
        source: 'yahoo'
      });
      return;
    }
  } catch (e) {}
}

let replayLines = [];
let replayIndex = 0;
let isReplaying = false;
let replayTimer = null;
let replaySpeed = 10;
let currentDataset = 'dhan_nifty_5days.ndjson';

function loadDataset(datasetName = 'dhan_nifty_5days.ndjson') {
  const filePath = path.join(__dirname, datasetName);
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      replayLines = content.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch(e) { return null; }
      }).filter(Boolean);
      currentDataset = datasetName;
      replayIndex = 0;
      console.log(`[Backtest] Loaded dataset ${datasetName} with ${replayLines.length} events.`);
      return true;
    } catch(e) {
      console.warn('[Backtest Error]', e.message);
      return false;
    }
  } else {
    console.warn(`[Backtest] File not found: ${filePath}`);
    return false;
  }
}

function startReplay(speed = 10, datasetName = 'dhan_nifty_5days.ndjson') {
  if (replayTimer) clearInterval(replayTimer);
  const ok = loadDataset(datasetName);
  if (!ok || !replayLines.length) return false;
  isReplaying = true;
  replaySpeed = speed;
  replayIndex = 0;
  feedMode = 'replay';
  broadcastStatus();

  const intervalMs = Math.max(15, Math.round(300 / replaySpeed));

  replayTimer = setInterval(() => {
    if (!isReplaying || replayIndex >= replayLines.length) {
      stopReplay();
      return;
    }
    const item = replayLines[replayIndex++];
    if (item.type === 'chain') {
      lastChain = item.chain;
      send({ type: 'chain', chain: lastChain });
    } else if (item.type === 'tick') {
      currentSpot = item.price;
      send(item);
    }
  }, intervalMs);
  return true;
}

function stopReplay() {
  isReplaying = false;
  if (replayTimer) clearInterval(replayTimer);
  feedMode = (dhanActive ? 'dhan' : (kiteActive ? 'kite' : 'live_market'));
  broadcastStatus();
}

// Background real-time spot poller (runs every 4 seconds independently)
setInterval(() => {
  if (Date.now() - lastBrokerTickTime > 3000) {
    pollRealMarketSpot().catch(() => {});
  }
}, 4000);

function startLiveMarketStreamer() {
  if (liveMarketInterval) clearInterval(liveMarketInterval);

  // Broadcast real status and spot every 4 seconds.
  // Note: NO synthetic random ticks are pumped when market is closed or waiting.
  // Real live ticks flow from Dhan HQ / Zerodha Kite WebSocket when market is active.
  liveMarketInterval = setInterval(() => {
    if (isReplaying) return;
    broadcastStatus();
  }, 4000);
}

// Refresh Option Chain (Live)
async function refreshOptionChain(requestedExpiry = null, requestedSymbol = 'NIFTY') {
  try {
    const sym = String(requestedSymbol || 'NIFTY').toUpperCase();
    if (DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN) {
      const dhanChain = await fetchDhanOptionChain(requestedExpiry, sym);
      if (dhanChain) {
        if (sym === 'NIFTY' && !requestedExpiry) {
          lastChain = dhanChain;
        }
        send({ type: 'chain', chain: dhanChain });
        return dhanChain;
      }
    }

    if (kiteActive && kiteOpts.length > 0 && kiteFut && sym === 'NIFTY') {
      lastChain = await buildKiteChain(kiteOpts, kiteFut);
      if (lastChain) lastChain.fetchedAt = Date.now();
      send({ type: 'chain', chain: lastChain });
      return lastChain;
    }
    if (sym === 'NIFTY' && lastChain) {
      send({ type: 'chain', chain: lastChain });
      return lastChain;
    }
    return null;
  } catch (e) {
    console.warn('[Chain Refresh]', e.message);
    return null;
  }
}

// Native Dhan HQ v2 WebSocket Feed Client
// ================= Dhan NIFTY futures feed (real order flow) =================
let futState = null, idxSpot = 0;
function futLive() { return !!(futState && !futState.bad && futState.lastTickAt && Date.now() - futState.lastTickAt < 8000); }
async function startFutFeed() {
  if (process.env.DHAN_FUT_FLOW === '0') return;
  try {
    const f = await FLOW.resolveNiftyFuture(istParts().date);
    const prev = futState;
    futState = Object.assign({ builder: FLOW.makeTickBuilder(), lastTickAt: 0, pkts: 0, okPkts: 0, badPkts: 0, bad: false }, f);
    const sendSub = (code, id) => { if (dhanWs && dhanWs.readyState === 1) dhanWs.send(JSON.stringify({ RequestCode: code, InstrumentCount: 1, InstrumentList: [{ ExchangeSegment: 'NSE_FNO', SecurityId: id }] })); };
    if (prev && prev.secId !== f.secId) sendSub(22, prev.secId);
    sendSub(21, f.secId);
    console.log('[Dhan Futures] ' + f.symbol + ' (id ' + f.secId + ', expiry ' + f.expiry + ', lot ' + f.lot + ') Full feed subscribe kiya');
    if (f.lot > 0 && f.lot !== LOT_SIZES.NIFTY) {
      console.warn('[Lot] Dhan scrip master me NIFTY lot = ' + f.lot + ', aapke config me ' + LOT_SIZES.NIFTY + '. Dono match karo (HTML me LOT bhi).');
      if (!process.env.NIFTY_LOT_SIZE) LOT_SIZES.NIFTY = f.lot;
    }
  } catch (e) { console.warn('[Dhan Futures] shuru nahi hua:', e.message, '-> inferred flow par chalega'); futState = null; }
}
function handleFutPacket(buf) {
  if (!futState || futState.bad) return;
  const p = FLOW.parseFull(buf);
  if (!p || String(p.secId) !== futState.secId) return;
  futState.pkts++;
  if (process.env.DEBUG_FLOW === '1' && futState.pkts <= 3) console.log('[DEBUG_FLOW]', buf.length, 'bytes', JSON.stringify(p));
  if (!FLOW.sane(p, idxSpot || currentSpot || 0)) {
    futState.badPkts++;
    if (futState.pkts >= 20 && futState.okPkts / futState.pkts < 0.5) { futState.bad = true; console.warn('[Dhan Futures] packet layout/sanity fail: real flow band, inferred par wapas. DEBUG_FLOW=1 ke saath chalao aur log bhejo.'); }
    return;
  }
  futState.okPkts++;
  const now = Date.now();
  futState.lastTickAt = now; lastBrokerTickTime = now;
  currentFut = Math.round(p.ltp * 20) / 20;
  // Fallback to futures only if spot is not yet set
  if (!currentSpot || spotSource === 'none') {
    currentSpot = currentFut;
    spotSource = 'dhan-futures';
    lastSpotTs = now;
    if (lastChain) {
      lastChain.spot = currentSpot;
      const step = lastChain.step || 50;
      lastChain.atm = Math.round(currentSpot / step) * step;
    }
  }
  const tk = futState.builder(p, now);
  if (tk) {
    tk.spot = currentSpot;
    tk.fut = currentFut;
    send(tk);
  }
}
setInterval(() => { if (dhanWs && dhanWs.readyState === 1 && (!futState || futState.expiry <= istParts().date)) startFutFeed().catch(() => {}); }, 30 * 60 * 1000);   // futures rollover

function connectDhanV2Feed() {
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) return;
  if (dhanWs) {
    try {
      dhanWs.removeAllListeners();
      dhanWs.close();
    } catch (e) {}
    dhanWs = null;
  }
  clearTimeout(dhanReconnectTimer);

  const url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(DHAN_ACCESS_TOKEN)}&clientId=${encodeURIComponent(DHAN_CLIENT_ID)}&authType=2`;

  try {
    dhanWs = new WebSocket(url);

    dhanWs.on('open', () => {
      console.log('[Dhan Feed] Connected successfully to Dhan HQ Live Market Feed (v2)!');
      dhanActive = true;
      feedMode = 'dhan';
      dhanError = null;
      broadcastStatus();

      // Subscribe to NIFTY 50 Index: SecurityId 13, ExchangeSegment: IDX_I
      const sub = {
        RequestCode: 15,
        InstrumentCount: 1,
        InstrumentList: [
          { ExchangeSegment: 'IDX_I', SecurityId: '13' }
        ]
      };
      try { dhanWs.send(JSON.stringify(sub)); } catch (e) {}
      startFutFeed().catch(() => {});   // NIFTY futures depth (real order flow)
    });

    dhanWs.on('message', (data) => {
      if (!Buffer.isBuffer(data) || data.length < 12) return;
      const respCode = data.readUInt8(0);
      if (respCode === 8) { handleFutPacket(data); return; }
      // Code 2 = Ticker (16 bytes), Code 4 = Quote (50 bytes)
      if (respCode === 2 || respCode === 4) {
        const ltp = data.readFloatLE(8);
        if (ltp && isFinite(ltp) && ltp > 1000) {
          const spotVal = Math.round(ltp * 20) / 20;
          idxSpot = spotVal;
          currentSpot = spotVal;
          spotSource = 'dhan-ws';
          lastSpotTs = Date.now();
          lastBrokerTickTime = Date.now();
          if (lastChain) {
            lastChain.spot = currentSpot;
            const step = lastChain.step || 50;
            lastChain.atm = Math.round(currentSpot / step) * step;
          }

          // Immediately broadcast real live spot to UI
          send({
            type: 'spot',
            spot: currentSpot,
            fut: currentFut,
            source: 'dhan-ws',
            ts: Date.now()
          });

          // Inferred flow only if real futures flow is not live
          if (!futLive()) {
            const spread = 0.10;
            const bid = Math.round((currentSpot - spread / 2) * 20) / 20;
            const ask = Math.round((currentSpot + spread / 2) * 20) / 20;
            const side = lastTickPx === 0 ? 1 : (currentSpot > lastTickPx ? 1 : (currentSpot < lastTickPx ? -1 : lastTickSide));
            lastTickPx = currentSpot; lastTickSide = side;

            send({
              type: 'tick',
              ts: Date.now(),
              price: currentSpot,
              spot: currentSpot,
              fut: currentFut,
              qty: LOT_SIZES.NIFTY,
              inferred: true,
              bid,
              ask,
              bidQty: 1200,
              askQty: 1200,
              side
            });
          }
        }
      }
    });

    dhanWs.on('error', (err) => {
      console.warn('[Dhan Feed] WS notice:', err.message);
      dhanReconnectTimer = setTimeout(connectDhanV2Feed, 5000);
    });

    dhanWs.on('close', (code, reason) => {
      console.log(`[Dhan Feed] WS closed (${code}): ${reason || 'normal disconnect'}`);
      dhanReconnectTimer = setTimeout(connectDhanV2Feed, 5000);
    });
  } catch (err) {
    console.warn('[Dhan Feed] Connect exception:', err.message);
    dhanReconnectTimer = setTimeout(connectDhanV2Feed, 5000);
  }
}

// Dhan HQ initialization
async function initDhan() {
  DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID || DHAN_CLIENT_ID;
  DHAN_ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN || DHAN_ACCESS_TOKEN;
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) {
    console.log('[Dhan] No credentials provided.');
    dhanActive = false;
    feedMode = 'live_market';
    broadcastStatus();
    return;
  }

  try {
    console.log('[Dhan] Validating Dhan HQ credentials...');
    // Pre-validate token
    const authCheck = await fetch('https://api.dhan.co/v2/fundlimit', {
      headers: {
        'access-token': DHAN_ACCESS_TOKEN,
        'client-id': DHAN_CLIENT_ID
      }
    });
    const authData = await authCheck.json();
    if (authData.errorCode || authData.errorType) {
      console.warn('[Dhan Auth Error]', authData.errorMessage);
      dhanError = authData.errorMessage || 'Client ID or Access Token is invalid or expired.';
      dhanActive = false;
      feedMode = 'live_market';
      broadcastStatus();
      return;
    }

    console.log('[Dhan] Credentials valid! Initializing Live Feed...');
    dhanActive = true;
    feedMode = 'dhan';
    dhanError = null;

    // Fetch real option chain from Dhan
    const oc = await fetchDhanOptionChain();
    if (oc) {
      lastChain = oc;
      send({ type: 'chain', chain: lastChain });
    }

    // Connect native Dhan v2 WebSocket
    connectDhanV2Feed();
    broadcastStatus();
  } catch (err) {
    console.warn('[Dhan Init Error]', err.message);
    dhanError = err.message;
    dhanActive = false;
    broadcastStatus();
  }
}

// Zerodha Kite initialization
async function initKite() {
  if (!KITE_API_KEY || (!KITE_ACCESS_TOKEN && !REQUEST_TOKEN)) {
    kiteActive = false;
    feedMode = 'live_market';
    broadcastStatus();
    return;
  }

  try {
    kiteConnect = new KiteConnect({ api_key: KITE_API_KEY });

    if (REQUEST_TOKEN && KITE_API_SECRET) {
      try {
        console.log('[Kite] Generating session from REQUEST_TOKEN...');
        const session = await kiteConnect.generateSession(REQUEST_TOKEN, KITE_API_SECRET);
        KITE_ACCESS_TOKEN = session.access_token;
        REQUEST_TOKEN = '';
      } catch (sessErr) {
        console.warn('[Kite Session Error]', sessErr.message);
        kiteError = `Session failed: ${sessErr.message}`;
      }
    }

    if (!KITE_ACCESS_TOKEN) {
      kiteActive = false;
      feedMode = 'live_market';
      broadcastStatus();
      return;
    }

    kiteConnect.setAccessToken(KITE_ACCESS_TOKEN);

    const nfo = await kiteConnect.getInstruments('NFO');
    const nifty = nfo.filter(i => i.name === 'NIFTY');
    kiteFut = nifty.filter(i => i.instrument_type === 'FUT').sort((a, b) => a.expiry - b.expiry)[0];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const optAll = nifty.filter(i => (i.instrument_type === 'CE' || i.instrument_type === 'PE') && i.expiry >= today);
    const exp = Math.min(...optAll.map(o => +o.expiry));
    kiteOpts = optAll.filter(o => +o.expiry === exp);

    await refreshOptionChain();

    if (kiteTicker) {
      try { kiteTicker.disconnect(); } catch (e) {}
    }

    kiteTicker = new KiteTicker({ api_key: KITE_API_KEY, access_token: KITE_ACCESS_TOKEN });
    let lastVol = null;

    kiteTicker.on('connect', () => {
      console.log('[Kite Ticker] Connected successfully.');
      kiteActive = true;
      feedMode = 'kite';
      kiteError = null;
      kiteTicker.subscribe([kiteFut.instrument_token]);
      kiteTicker.setMode(kiteTicker.modeFull, [kiteFut.instrument_token]);
      broadcastStatus();
    });

    kiteTicker.on('ticks', ticks => {
      for (const t of ticks) {
        const vol = t.volume_traded;
        const qty = lastVol == null ? (t.last_quantity || 1) : vol - lastVol;
        lastVol = vol;
        if (qty <= 0 || !t.depth) continue;
        const b = t.depth.buy[0] || { price: t.last_price, quantity: 100 };
        const a = t.depth.sell[0] || { price: t.last_price, quantity: 100 };
        currentSpot = t.last_price;   // NOTE: ye NIFTY FUTURES ka price hai (index spot se basis ka farak)
        lastBrokerTickTime = Date.now(); spotSource = 'kite-futures'; lastSpotTs = Date.now();
        send({
          type: 'tick',
          ts: Date.now(),
          price: t.last_price,
          qty,
          bid: b.price,
          ask: a.price,
          bidQty: b.quantity,
          askQty: a.quantity
        });
      }
    });

    kiteTicker.on('error', err => {
      kiteError = (err.message || 'Ticker error');
      if (err.message && err.message.includes('400')) {
        kiteError = 'Invalid or expired Kite token.';
        kiteActive = false;
        feedMode = 'live_market';
        try { kiteTicker.disconnect(); } catch (e) {}
      }
      broadcastStatus();
    });

    kiteTicker.connect();
  } catch (err) {
    console.warn('[Kite Setup Error]', err.message);
    kiteError = err.message;
    kiteActive = false;
    broadcastStatus();
  }
}

// ================= Telegram watchers (health / events / news) =================
let lastNewsAlert = Date.now(), wasBad = false;
function startWatchers() {
  setInterval(() => {
    try {
      const h = computeHealth(), open = h.market.state === 'OPEN';
      let bad = false;
      for (const c of h.checks) {
        if (c.level === 'bad' && c.critical && (open || c.id === 'dtoken')) { bad = true; ALERTS.notify('🔴 ' + c.label + ': ' + c.detail, 'h-' + c.id, 30 * 60000); }
        if (c.id === 'dtoken' && c.level === 'warn') ALERTS.notify('⚠️ ' + c.label + ': ' + c.detail, 'h-dtoken-warn', 6 * 3600000);
        if (c.id === 'flow' && c.level === 'warn' && open && feedMode === 'dhan' && futState && futState.bad) ALERTS.notify('⚠️ Order flow: ' + c.detail, 'h-flowbad', 6 * 3600000);
      }
      if (wasBad && !bad) ALERTS.notify('🟢 Data health wapas theek', 'h-ok', 5 * 60000);
      wasBad = bad;
      const snap = NEWS.snapshot({ nextWeeklyExpiry });
      for (const e of snap.events) { const m = (e.ts - Date.now()) / 60000; [60, 15].forEach(w => { if (m > 0 && m <= w) ALERTS.notify('⏰ ' + e.title + ' ' + Math.round(m) + ' min me (' + e.date + ' ' + (e.time || '') + ' IST)', 'ev-' + e.title + e.date + w, 86400000); }); }
      for (const a of snap.alerts) if (a.at > lastNewsAlert) { ALERTS.notify((a.label === 'POSITIVE' ? '🟢 ' : '🔴 ') + a.title + ' [' + a.verify + ', ' + a.source + ']' + (a.stocks.length ? ' ' + a.stocks.join(',') : ''), 'n-' + a.title, 86400000); lastNewsAlert = Math.max(lastNewsAlert, a.at); }
    } catch (e) {}
  }, 30000);
}

// Start Server
async function start() {
  server.listen(PORT, HOST, () => {
    console.log(`\n============================================================`);
    console.log(` Institutional Quant Engine: Live Bridge with Dhan HQ & Kite`);
    console.log(` Local Dashboard : http://localhost:${PORT}`);
    console.log(` Mobile / Network: http://192.168.29.60:${PORT}`);
    console.log(` Lot ${LOT_SIZES.NIFTY} | Next weekly expiry ${nextWeeklyExpiry()} | Market ${marketState().state}`);
    console.log(` Status: Running live without error`);
    console.log(`============================================================\n`);
  });

  NEWS.start();
  if (ALERTS.enabled()) ALERTS.notify('🟢 Quant Engine chalu. Lot ' + LOT_SIZES.NIFTY + ', agla expiry ' + nextWeeklyExpiry(), 'boot-' + istParts().date, 6 * 3600 * 1000);
  startWatchers();
  await fetchIntradayCandles();
  await refreshOptionChain();
  setInterval(refreshOptionChain, 3500);
  startLiveMarketStreamer();

  const activeBroker = process.env.ACTIVE_BROKER || ((DHAN_CLIENT_ID && (DHAN_ACCESS_TOKEN || (DHAN_PIN && DHAN_TOTP_SECRET))) ? 'dhan' : (KITE_API_KEY ? 'kite' : 'auto'));

  if (activeBroker === 'dhan') {
    // Check if token is expired and auto-login is possible
    const ex = DHAN_ACCESS_TOKEN ? jwtExpiry(DHAN_ACCESS_TOKEN) : 0;
    const isExpired = !ex || ex <= Date.now();
    if (isExpired && DHAN_CLIENT_ID && DHAN_PIN && DHAN_TOTP_SECRET) {
      console.log('[Dhan Startup] Access Token missing or expired. Attempting Zero-Touch Auto-Login via TOTP...');
      try {
        const loginRes = await DHAN_AUTH.autoLoginDhan({
          clientId: DHAN_CLIENT_ID,
          pin: DHAN_PIN,
          totpSecret: DHAN_TOTP_SECRET
        });
        if (loginRes.success && loginRes.token) {
          DHAN_ACCESS_TOKEN = loginRes.token;
          process.env.DHAN_ACCESS_TOKEN = loginRes.token;
          console.log('[Dhan Startup] ✅ Auto-Login successful! Connected with fresh token.');
        } else {
          console.warn('[Dhan Startup] Auto-Login failed:', loginRes.message);
        }
      } catch (e) {
        console.warn('[Dhan Startup] Auto-Login error:', e.message);
      }
    }

    if (DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN) {
      await initDhan();
    } else {
      console.log('[Mode] Dhan configured but waiting for valid access token or TOTP credentials.');
    }
  } else if (activeBroker === 'kite' && KITE_API_KEY && (KITE_ACCESS_TOKEN || REQUEST_TOKEN)) {
    await initKite();
  } else {
    console.log('[Mode] Live Market feed active (Real NIFTY spot & order flow).');
    console.log('[Mode] Dhan HQ or Zerodha Kite can be connected via Web UI settings anytime.');
  }

  // Auto-renew Dhan token every 12 hours, fallback to TOTP Auto-Login if expired
  setInterval(async () => {
    if (DHAN_CLIENT_ID && DHAN_ACCESS_TOKEN) {
      console.log('[Dhan Scheduled Check] Checking & renewing token validity...');
      const renew = await renewDhanToken();
      if (!renew.success && DHAN_PIN && DHAN_TOTP_SECRET) {
        console.log('[Dhan Scheduled Check] Regular renewal failed; triggering TOTP Auto-Login...');
        const login = await DHAN_AUTH.autoLoginDhan({
          clientId: DHAN_CLIENT_ID,
          pin: DHAN_PIN,
          totpSecret: DHAN_TOTP_SECRET
        });
        if (login.success && !dhanActive) {
          await initDhan();
        }
      }
    }
  }, 12 * 60 * 60 * 1000);
}

start().catch(err => {
  console.error('[Fatal Start Error]', err);
});
