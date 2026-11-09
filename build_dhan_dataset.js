#!/usr/bin/env node
'use strict';
/**
 * DHAN HISTORICAL DATASET BUILDER
 * Downloads real Dhan HQ intraday candles (1m) & Option Chain data
 * and compiles them into .ndjson format for:
 *   1. Strategy Lab backtesting (node strategy_lab.js)
 *   2. Dashboard historical replay (/api/replay)
 *
 * Usage:
 *   node build_dhan_dataset.js
 *   node build_dhan_dataset.js --days 10 --symbol NIFTY
 *   node build_dhan_dataset.js --from 2026-10-01 --to 2026-10-09 --out my_dataset.ndjson
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID;
const DHAN_ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN;

if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) {
  console.error('❌ Error: DHAN_CLIENT_ID aur DHAN_ACCESS_TOKEN .env file me zaroori hain.');
  process.exit(1);
}

// Arguments
const args = process.argv.slice(2);
function getArg(key, def) {
  const idx = args.indexOf('--' + key);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
}

const symbol = (getArg('symbol', 'NIFTY')).toUpperCase();
const numDays = parseInt(getArg('days', '5'), 10);
const customFrom = getArg('from', null);
const customTo = getArg('to', null);

const UNDERLYINGS = {
  'NIFTY': { name: 'NIFTY 50', scrip: '13', seg: 'IDX_I', step: 50 },
  'BANKNIFTY': { name: 'BANK NIFTY', scrip: '25', seg: 'IDX_I', step: 100 },
  'FINNIFTY': { name: 'FIN NIFTY', scrip: '27', seg: 'IDX_I', step: 50 },
  'SENSEX': { name: 'SENSEX', scrip: '51', seg: 'IDX_I', step: 100 }
};

const conf = UNDERLYINGS[symbol] || UNDERLYINGS['NIFTY'];

// Calculate date range
function formatDate(d) {
  return d.toISOString().split('T')[0];
}

const now = new Date();
const toDate = customTo || formatDate(now);
let fromDate = customFrom;
if (!fromDate) {
  const d = new Date(now.getTime() - (numDays * 1.5 + 2) * 24 * 60 * 60 * 1000);
  fromDate = formatDate(d);
}

const defaultOutFile = `dhan_${symbol.toLowerCase()}_${numDays}days.ndjson`;
const outFile = getArg('out', defaultOutFile);

const headers = {
  'access-token': DHAN_ACCESS_TOKEN,
  'client-id': DHAN_CLIENT_ID,
  'Content-Type': 'application/json'
};

async function main() {
  console.log(`\n============================================================`);
  console.log(` 📥 Dhan HQ Historical Dataset Builder`);
  console.log(` Symbol:    ${conf.name} (Scrip: ${conf.scrip}, Segment: ${conf.seg})`);
  console.log(` Range:     ${fromDate} -> ${toDate}`);
  console.log(` Output:    ${outFile}`);
  console.log(`============================================================\n`);

  // 1. Fetch Option Chain for real strike structure
  console.log('1️⃣ Fetching Option Chain snapshot from Dhan HQ...');
  let chainData = null;
  try {
    const expRes = await fetch('https://api.dhan.co/v2/optionchain/expirylist', {
      method: 'POST',
      headers,
      body: JSON.stringify({ UnderlyingScrip: parseInt(conf.scrip, 10), UnderlyingSeg: conf.seg })
    });
    const expList = await expRes.json();
    const expiry = expList.data?.[0];

    if (expiry) {
      const ocRes = await fetch('https://api.dhan.co/v2/optionchain', {
        method: 'POST',
        headers,
        body: JSON.stringify({ UnderlyingScrip: parseInt(conf.scrip, 10), UnderlyingSeg: conf.seg, Expiry: expiry })
      });
      const ocData = await ocRes.json();
      if (ocData.status === 'success' && ocData.data?.oc) {
        const strikes = Object.keys(ocData.data.oc).map(Number).sort((a, b) => a - b);
        const spot = ocData.data.last_price;
        const atm = Math.round(spot / conf.step) * conf.step;
        const filtered = strikes.filter(s => Math.abs(s - atm) <= 25 * conf.step);
        const K = filtered.length ? filtered : strikes.slice(0, 51);

        const cOI = [], pOI = [], iv = [];
        K.forEach(s => {
          const row = ocData.data.oc[s.toFixed(6)] || ocData.data.oc[String(s)] || ocData.data.oc[s] || {};
          cOI.push(row.ce?.oi || 0);
          pOI.push(row.pe?.oi || 0);
          iv.push((row.ce?.implied_volatility || 12) / 100);
        });

        chainData = { K, cOI, pOI, iv };
        console.log(`   ✅ Option Chain fetched: ${K.length} strikes around spot ${spot} (Expiry: ${expiry})`);
      }
    }
  } catch (e) {
    console.warn('   ⚠️ Option chain fetch warning:', e.message);
  }

  // Fallback synthetic chain if needed
  if (!chainData) {
    const defaultAtm = symbol === 'BANKNIFTY' ? 55000 : (symbol === 'SENSEX' ? 72000 : 22500);
    const K = [];
    for (let i = -24; i <= 24; i++) K.push(defaultAtm + i * conf.step);
    chainData = {
      K,
      cOI: K.map(() => 500000),
      pOI: K.map(() => 500000),
      iv: K.map(() => 0.125)
    };
  }

  // 2. Fetch 1m Intraday Candles
  console.log('2️⃣ Downloading official 1-minute historical candles...');
  const chartRes = await fetch('https://api.dhan.co/v2/charts/intraday', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      securityId: conf.scrip,
      exchangeSegment: conf.seg,
      instrument: 'INDEX',
      interval: '1',
      oi: false,
      fromDate,
      toDate
    })
  });

  const chartData = await chartRes.json();
  if (!chartData || !Array.isArray(chartData.open) || chartData.open.length === 0) {
    console.error('❌ Error: Dhan se candle data nahi mila.', JSON.stringify(chartData));
    process.exit(1);
  }

  const nCandles = chartData.open.length;
  console.log(`   ✅ Downloaded ${nCandles} 1-minute candles from Dhan HQ!`);

  // 3. Group by trading day (IST date)
  console.log('3️⃣ Compiling into order-flow ticks (.ndjson)...');
  const dayBuckets = {};

  for (let i = 0; i < nCandles; i++) {
    const epochSec = chartData.timestamp[i];
    const tsMs = epochSec * 1000;
    // IST offset: +5:30 = 19,800,000 ms
    const istDate = new Date(tsMs + 19800000).toISOString().slice(0, 10);
    const secOfDay = ((tsMs + 19800000) / 1000) % 86400;

    // Filter regular NSE market hours (09:15 to 15:30 IST = 33300 to 55800 sec)
    if (secOfDay < 33300 || secOfDay > 55800) continue;

    if (!dayBuckets[istDate]) dayBuckets[istDate] = [];
    dayBuckets[istDate].push({
      ts: tsMs,
      o: chartData.open[i],
      h: chartData.high[i],
      l: chartData.low[i],
      c: chartData.close[i],
      v: chartData.volume[i] || 350
    });
  }

  const tradingDays = Object.keys(dayBuckets).sort();
  console.log(`   Found ${tradingDays.length} market trading days: ${tradingDays.join(', ')}`);

  // Take requested number of recent days
  const selectedDays = tradingDays.slice(-numDays);

  const writeStream = fs.createWriteStream(path.join(__dirname, outFile), { encoding: 'utf8' });
  let totalTicks = 0;
  let totalChains = 0;

  for (const day of selectedDays) {
    const candles = dayBuckets[day];
    if (!candles || candles.length < 50) continue;

    // A. Emit Option Chain snapshot at start of day (09:15 AM)
    const dayStartTs = candles[0].ts;
    const chainEvent = {
      type: 'chain',
      ts: dayStartTs,
      chain: chainData
    };
    writeStream.write(JSON.stringify(chainEvent) + '\n');
    totalChains++;

    // B. Decompose each 1-minute candle into 6 realistic micro-ticks (Open -> Path -> Close)
    for (const c of candles) {
      const o = c.o, h = c.h, l = c.l, cl = c.c;
      const vol = Math.max(120, c.v);
      const isBull = cl >= o;
      const spread = 0.10;

      // Intra-minute progression:
      // Bull candle: Open -> dip to Low -> rally to High -> close at Close
      // Bear candle: Open -> pop to High -> flush to Low -> close at Close
      const pathPoints = isBull
        ? [o, o + (l - o) * 0.5, l, (l + h) * 0.5, h, cl]
        : [o, o + (h - o) * 0.5, h, (h + l) * 0.5, l, cl];

      const stepMs = 10000; // 6 points over 60 seconds (every 10s)

      for (let pIdx = 0; pIdx < pathPoints.length; pIdx++) {
        const px = Math.round(pathPoints[pIdx] * 20) / 20;
        const tickTs = c.ts + pIdx * stepMs;
        const prevPx = pIdx > 0 ? pathPoints[pIdx - 1] : o;
        const side = px >= prevPx ? 1 : -1;
        const q = Math.max(15, Math.round(vol / 6 * (0.7 + 0.6 * Math.random())));

        const bid = Math.round((px - spread / 2) * 20) / 20;
        const ask = Math.round((px + spread / 2) * 20) / 20;
        const bidQty = Math.round(800 + Math.random() * 1200);
        const askQty = Math.round(800 + Math.random() * 1200);

        const tickEvent = {
          type: 'tick',
          ts: tickTs,
          price: px,
          qty: q,
          bid,
          ask,
          bidQty,
          askQty,
          side,
          synthetic: true   // 1-min candle se banaya; qty/bid/ask qty random hain, real order flow nahi
        };

        writeStream.write(JSON.stringify(tickEvent) + '\n');
        totalTicks++;
      }
    }
  }

  writeStream.end();

  console.log(`\n============================================================`);
  console.log(` ✅ SUCCESS! Dataset compiled successfully!`);
  console.log(` File:        ${outFile}`);
  console.log(` Days:        ${selectedDays.length} trading days (${selectedDays[0]} -> ${selectedDays[selectedDays.length - 1]})`);
  console.log(` Total Ticks: ${totalTicks.toLocaleString('en-IN')}`);
  console.log(` Chains:      ${totalChains} snapshots`);
  console.log(`============================================================\n`);
  console.log(`Kaise use karein:`);
  console.log(`1. Backtesting Strategy Lab me chalane ke liye:`);
  console.log(`   node strategy_lab.js --allow-sim ${outFile}`);
  console.log(`2. Web Dashboard me Replay karne ke liye:`);
  console.log(`   Is file ko 'sample_simulated_3days.ndjson' ki jagah replace karke dashboard se Replay button dabayein.\n`);
}

main().catch(err => {
  console.error('Fatal Error:', err);
});
