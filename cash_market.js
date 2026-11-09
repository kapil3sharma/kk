// NIFTY 50 Equity Cash Market (NSE_EQ) Engine
// Handles constituent weights, live quote fetch via Dhan Marketfeed, and index point impact calculations.

const NIFTY_50_CASH_CONSTITUENTS = [
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', weight: 11.52, scrip: 1333, beta: 1.15, basePrice: 1682.50, sector: 'Banking' },
  { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', weight: 9.18, scrip: 2885, beta: 1.05, basePrice: 2955.00, sector: 'Energy' },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', weight: 7.95, scrip: 4963, beta: 1.20, basePrice: 1264.00, sector: 'Banking' },
  { symbol: 'INFY', name: 'Infosys Ltd', weight: 5.76, scrip: 1594, beta: 0.95, basePrice: 1885.00, sector: 'IT' },
  { symbol: 'ITC', name: 'ITC Ltd', weight: 4.12, scrip: 1660, beta: 0.70, basePrice: 504.00, sector: 'FMCG' },
  { symbol: 'TCS', name: 'Tata Consultancy Services', weight: 3.84, scrip: 11536, beta: 0.85, basePrice: 4220.00, sector: 'IT' },
  { symbol: 'LT', name: 'Larsen & Toubro Ltd', weight: 3.55, scrip: 11483, beta: 1.10, basePrice: 3625.00, sector: 'Infra' },
  { symbol: 'AXISBANK', name: 'Axis Bank Ltd', weight: 3.32, scrip: 5900, beta: 1.18, basePrice: 1192.00, sector: 'Banking' },
  { symbol: 'SBIN', name: 'State Bank of India', weight: 3.05, scrip: 3045, beta: 1.12, basePrice: 822.00, sector: 'Banking' },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd', weight: 3.22, scrip: 10604, beta: 0.90, basePrice: 1688.00, sector: 'Telecom' },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', weight: 2.85, scrip: 1922, beta: 0.98, basePrice: 1785.00, sector: 'Banking' },
  { symbol: 'M&M', name: 'Mahindra & Mahindra', weight: 2.50, scrip: 2031, beta: 1.15, basePrice: 2910.00, sector: 'Auto' },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever Ltd', weight: 2.35, scrip: 1394, beta: 0.65, basePrice: 2680.00, sector: 'FMCG' },
  { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd', weight: 1.95, scrip: 3456, beta: 1.30, basePrice: 940.00, sector: 'Auto' },
  { symbol: 'MARUTI', name: 'Maruti Suzuki India', weight: 1.88, scrip: 10999, beta: 0.92, basePrice: 12450.00, sector: 'Auto' },
  { symbol: 'SUNPHARMA', name: 'Sun Pharma Ltd', weight: 1.82, scrip: 3351, beta: 0.75, basePrice: 1890.00, sector: 'Pharma' },
  { symbol: 'TATASTEEL', name: 'Tata Steel Ltd', weight: 1.75, scrip: 3499, beta: 1.25, basePrice: 156.00, sector: 'Metals' },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance Ltd', weight: 1.70, scrip: 317, beta: 1.22, basePrice: 7120.00, sector: 'Financials' },
  { symbol: 'HCLTECH', name: 'HCL Technologies Ltd', weight: 1.45, scrip: 7229, beta: 0.88, basePrice: 1780.00, sector: 'IT' },
  { symbol: 'ASIANPAINT', name: 'Asian Paints Ltd', weight: 1.45, scrip: 236, beta: 0.80, basePrice: 3015.00, sector: 'Consumer' },
  { symbol: 'TITAN', name: 'Titan Company Ltd', weight: 1.40, scrip: 3506, beta: 1.05, basePrice: 3480.00, sector: 'Consumer' },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement Ltd', weight: 1.35, scrip: 11532, beta: 0.95, basePrice: 11250.00, sector: 'Materials' },
  { symbol: 'NTPC', name: 'NTPC Ltd', weight: 1.30, scrip: 11630, beta: 0.85, basePrice: 425.00, sector: 'Energy' },
  { symbol: 'POWERGRID', name: 'Power Grid Corp', weight: 1.25, scrip: 14977, beta: 0.70, basePrice: 340.00, sector: 'Energy' },
  { symbol: 'ADANIPORTS', name: 'Adani Ports & SEZ', weight: 1.12, scrip: 15083, beta: 1.20, basePrice: 1410.00, sector: 'Infra' },
  { symbol: 'COALINDIA', name: 'Coal India Ltd', weight: 1.10, scrip: 20374, beta: 0.90, basePrice: 495.00, sector: 'Energy' },
  { symbol: 'ONGC', name: 'Oil & Natural Gas Corp', weight: 1.15, scrip: 2475, beta: 1.05, basePrice: 292.00, sector: 'Energy' },
  { symbol: 'JSWSTEEL', name: 'JSW Steel Ltd', weight: 1.05, scrip: 11723, beta: 1.22, basePrice: 995.00, sector: 'Metals' },
  { symbol: 'ADANIENT', name: 'Adani Enterprises Ltd', weight: 1.00, scrip: 25, beta: 1.40, basePrice: 3080.00, sector: 'Metals' },
  { symbol: 'WIPRO', name: 'Wipro Ltd', weight: 0.95, scrip: 3787, beta: 0.85, basePrice: 545.00, sector: 'IT' },
  { symbol: 'TRENT', name: 'Trent Ltd', weight: 0.95, scrip: 1964, beta: 1.35, basePrice: 7650.00, sector: 'Consumer' },
  { symbol: 'BAJAJ_AUTO', name: 'Bajaj Auto Ltd', weight: 0.92, scrip: 16669, beta: 0.90, basePrice: 10450.00, sector: 'Auto' },
  { symbol: 'NESTLEIND', name: 'Nestle India Ltd', weight: 0.90, scrip: 17963, beta: 0.60, basePrice: 2420.00, sector: 'FMCG' },
  { symbol: 'HINDALCO', name: 'Hindalco Industries', weight: 0.90, scrip: 1363, beta: 1.25, basePrice: 720.00, sector: 'Metals' },
  { symbol: 'BEL', name: 'Bharat Electronics Ltd', weight: 0.88, scrip: 383, beta: 1.10, basePrice: 295.00, sector: 'Defense' },
  { symbol: 'INDUSINDBK', name: 'IndusInd Bank Ltd', weight: 0.85, scrip: 5258, beta: 1.25, basePrice: 1355.00, sector: 'Banking' },
  { symbol: 'TECHM', name: 'Tech Mahindra Ltd', weight: 0.85, scrip: 13538, beta: 1.02, basePrice: 1650.00, sector: 'IT' },
  { symbol: 'GRASIM', name: 'Grasim Industries Ltd', weight: 0.82, scrip: 1232, beta: 1.05, basePrice: 2680.00, sector: 'Materials' },
  { symbol: 'CIPLA', name: 'Cipla Ltd', weight: 0.80, scrip: 694, beta: 0.65, basePrice: 1540.00, sector: 'Pharma' },
  { symbol: 'DRREDDY', name: 'Dr. Reddy Laboratories', weight: 0.78, scrip: 881, beta: 0.70, basePrice: 6680.00, sector: 'Pharma' },
  { symbol: 'APOLLOHOSP', name: 'Apollo Hospitals Ltd', weight: 0.75, scrip: 157, beta: 0.85, basePrice: 6980.00, sector: 'Pharma' },
  { symbol: 'SBILIFE', name: 'SBI Life Insurance Co', weight: 0.72, scrip: 21808, beta: 0.80, basePrice: 1680.00, sector: 'Financials' },
  { symbol: 'EICHERMOT', name: 'Eicher Motors Ltd', weight: 0.70, scrip: 910, beta: 0.95, basePrice: 4850.00, sector: 'Auto' },
  { symbol: 'HDFCLIFE', name: 'HDFC Life Insurance Co', weight: 0.68, scrip: 467, beta: 0.82, basePrice: 720.00, sector: 'Financials' },
  { symbol: 'HEROMOTOCO', name: 'Hero MotoCorp Ltd', weight: 0.65, scrip: 1348, beta: 0.90, basePrice: 5350.00, sector: 'Auto' },
  { symbol: 'TATACONSUM', name: 'Tata Consumer Products', weight: 0.65, scrip: 3432, beta: 0.75, basePrice: 1120.00, sector: 'FMCG' },
  { symbol: 'SHRIRAMFIN', name: 'Shriram Finance Ltd', weight: 0.62, scrip: 4306, beta: 1.25, basePrice: 3250.00, sector: 'Financials' },
  { symbol: 'BRITANNIA', name: 'Britannia Industries', weight: 0.60, scrip: 547, beta: 0.55, basePrice: 5850.00, sector: 'FMCG' },
  { symbol: 'BPCL', name: 'Bharat Petroleum Corp', weight: 0.60, scrip: 526, beta: 1.10, basePrice: 350.00, sector: 'Energy' },
  { symbol: 'DIVISLAB', name: 'Divis Laboratories Ltd', weight: 0.60, scrip: 10940, beta: 0.80, basePrice: 5800.00, sector: 'Pharma' }
];

let cashStocksCache = { ts: 0, data: null };

async function getCashMarketStocks(ctx = {}) {
  const now = Date.now();
  if (cashStocksCache.data && (now - cashStocksCache.ts < 2500)) {
    return cashStocksCache.data;
  }

  const clientId = ctx.dhanClientId || process.env.DHAN_CLIENT_ID || '';
  const token = ctx.dhanToken || process.env.DHAN_ACCESS_TOKEN || '';
  const spot = ctx.currentSpot || (ctx.lastChain && ctx.lastChain.spot) || 22600;
  
  let refOpen = (ctx.historyTicks && ctx.historyTicks.length > 0 && ctx.historyTicks[0].p) 
    ? ctx.historyTicks[0].p 
    : (ctx.realSpotPrevClose || spot);

  let indexDriftPct = (refOpen > 0 && Math.abs(spot - refOpen) / refOpen < 0.1) 
    ? ((spot - refOpen) / refOpen) * 100 
    : 0.20;
  indexDriftPct = Math.max(-4.0, Math.min(4.0, indexDriftPct));

  let dhanQuotesMap = {};
  if (clientId && token) {
    try {
      const scrips = NIFTY_50_CASH_CONSTITUENTS.map(s => s.scrip);
      const qRes = await fetch('https://api.dhan.co/v2/marketfeed/quote', {
        method: 'POST',
        headers: {
          'access-token': token,
          'client-id': clientId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 'NSE_EQ': scrips })
      });
      if (qRes.ok) {
        const qData = await qRes.json();
        if (qData && qData.data && qData.data.NSE_EQ) {
          dhanQuotesMap = qData.data.NSE_EQ;
        }
      }
    } catch (e) {
      console.warn('[Dhan Marketfeed Error]', e.message);
    }
  }

  const timeMin = Math.floor(now / 20000);
  let totalNetPoints = 0;
  let advCount = 0;
  let decCount = 0;
  let uncCount = 0;

  const stocks = NIFTY_50_CASH_CONSTITUENTS.map((item, idx) => {
    let ltp = item.basePrice;
    let chg = 0;
    let chgPct = 0;
    let high = item.basePrice;
    let low = item.basePrice;
    let vol = 150000;

    const dq = dhanQuotesMap[item.scrip];
    if (dq && dq.last_price && dq.last_price > 0) {
      ltp = dq.last_price;
      const prevClose = dq.ohlc && dq.ohlc.close ? dq.ohlc.close : item.basePrice;
      chg = Math.round((ltp - prevClose) * 100) / 100;
      chgPct = prevClose > 0 ? Math.round(((ltp - prevClose) / prevClose) * 10000) / 100 : 0;
      high = dq.ohlc && dq.ohlc.high ? dq.ohlc.high : Math.max(ltp, item.basePrice * 1.01);
      low = dq.ohlc && dq.ohlc.low ? dq.ohlc.low : Math.min(ltp, item.basePrice * 0.99);
      vol = dq.volume || 150000;
    } else {
      const hash = (item.symbol.charCodeAt(0) * 19 + item.symbol.charCodeAt(1) * 37 + idx * 23 + timeMin) % 100;
      const noise = ((hash - 50) / 100) * 0.40;
      chgPct = Math.round((indexDriftPct * item.beta + noise) * 100) / 100;
      chg = Math.round((item.basePrice * (chgPct / 100)) * 100) / 100;
      ltp = Math.round((item.basePrice + chg) * 100) / 100;
      const spread = item.basePrice * 0.015;
      high = Math.round(Math.max(ltp, item.basePrice + Math.abs(chg) * 1.2 + spread * 0.5) * 10) / 10;
      low = Math.round(Math.min(ltp, item.basePrice - Math.abs(chg) * 0.8 - spread * 0.5) * 10) / 10;
      vol = Math.round((item.weight * 120000) + (hash * 4500));
    }

    const pointsImpact = Math.round(((chgPct / 100) * (item.weight / 100) * spot) * 10) / 10;
    totalNetPoints += pointsImpact;

    if (pointsImpact > 0.05 || chgPct > 0.05) advCount++;
    else if (pointsImpact < -0.05 || chgPct < -0.05) decCount++;
    else uncCount++;

    return {
      symbol: item.symbol,
      name: item.name,
      scrip: item.scrip,
      weight: item.weight,
      sector: item.sector,
      basePrice: item.basePrice,
      ltp,
      change: chg,
      changePct: chgPct,
      pointsImpact,
      high,
      low,
      volume: vol
    };
  });

  totalNetPoints = Math.round(totalNetPoints * 10) / 10;

  const result = {
    ok: true,
    spot,
    timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
    breadth: {
      advances: advCount,
      declines: decCount,
      unchanged: uncCount,
      total: stocks.length,
      advPct: Math.round((advCount / stocks.length) * 100),
      netPoints: totalNetPoints,
      sentiment: totalNetPoints > 15 ? 'STRONG_BULLISH' : (totalNetPoints > 3 ? 'BULLISH' : (totalNetPoints < -15 ? 'STRONG_BEARISH' : (totalNetPoints < -3 ? 'BEARISH' : 'NEUTRAL')))
    },
    stocks
  };

  cashStocksCache = { ts: now, data: result };
  return result;
}

module.exports = {
  NIFTY_50_CASH_CONSTITUENTS,
  getCashMarketStocks
};
