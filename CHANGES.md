# Kya badla (14 Oct 2026)

## Galat/purana data theek kiya
- NIFTY lot size 75 -> 65 (HTML engine + server). `.env` me NIFTY_LOT_SIZE se badal sakte ho.
- Hardcoded expiry `2026-10-13` hataya. Ab fallback = agla Tuesday weekly expiry, holiday ke hisaab se (20 Oct holiday hai, to expiry 19 Oct).
- `22500` spot fallbacks hataye. Spot na mile to chain skip hoti hai, jhootha number nahi dikhta.
- Dhan feed me `Math.random()` se buy/sell side banta tha. Ab tick rule (price upar = buy, neeche = sell).
- Intraday PCR table me missing slots ke nakli numbers aur BUY/SELL signal bante the. Ab wo rows "est." dikhti hain, signal "NO DATA".
- Kite mode me futures price par Yahoo/chain ka index spot overwrite hota tha. Fix.
- `build_dhan_dataset.js` ke ticks 1-min candle se bane hain (qty/depth random), ab `synthetic:true`. `strategy_lab.js` unhe default me skip karta hai.

## Naye features
1. Data health bar (top): feed age, order flow real/inferred, chain age, Dhan token expiry, expiry day, lot size, recorder. `/api/health` bhi hai.
2. Health kharab ho to trades auto-block (STAND ASIDE + wajah). Inferred flow par block default ON, Risk panel ke checkbox se allow kar sakte ho.
3. Expiry day: 13:30 ke baad naye trade block.
4. Market state: weekend, holiday, pre-open, open, close. `holidays.json` me dates jod sakte ho.
5. Daily tick recorder: market hours me `ticks-YYYY-MM-DD.ndjson` (ticks + har 60s chain). Pehle ye sirf docs me likha tha, code me tha hi nahi.
6. Server ab default `127.0.0.1` par chalta hai (pehle sabke liye khula tha). Phone se kholna ho to `.env` me HOST=0.0.0.0.

## Dhyan do
- Dhan index feed me real volume/depth nahi hota. Real order flow ke liye Kite (NIFTY futures depth) chahiye.
- Strategy lab ab real recorded ticks maangta hai. Kam se kam 10 din record karo, phir `node strategy_lab.js`.
- STT/brokerage ka cost model (HTML me `optionPlan`) maine nahi badla, verify nahi kar paya. Broker contract note se milao.
- Holidays aur lot size internet sources se liye hain. NSE circular se ek baar confirm karo.

# Part 2: News, Events, FII/DII
- `news_feed.js` (naya): RBI, SEBI, ET, Moneycontrol, Mint, Business Standard, BusinessLine ke RSS feeds, har 2 min.
- Har headline POSITIVE/NEGATIVE/NEUTRAL (keyword based, rough). Source check: OFFICIAL / CONFIRMED (2+ sources) / SINGLE SOURCE.
- Stock-wise news tilt (NIFTY large caps). Stocks ki list `watchlist.json` se badal sakte ho.
- Events: RBI MPC (4 Dec 2026, 5 Feb 2027, RBI ki official list), NIFTY expiry, Fed (date verify karo). Apne events/results `events.json` me daalo. 60 aur 15 min pehle alert.
- Alert: naya CONFIRMED/OFFICIAL zor wala news aaye to banner + beep + browser notification.
- FII/DII daily net NSE se (block ho sakta hai). Na mile to `fii_dii.json` me {"date":"..","fii":-1200,"dii":1500} daalo.
- Stock-wise FII holding: `fii_holdings.json` me do quarter ka % daalo, dashboard badlav dikhata hai.
- Ye sab internet wala hissa maine yahan live test nahi kiya (sandbox me internet nahi). Parser/sentiment sample data par test hue. Dashboard me neeche "Feeds: ✓/✗" line dikhati hai kaun sa feed chal raha hai.

# Part 3: Paper trading, Real order flow, Telegram
- `paper.js` + dashboard "Paper trading" panel: live signals virtual trade ban kar `paper_trades.ndjson` me. Win%, expectancy R (95% range), profit factor, max drawdown, grade/setup-wise, equity curve. 30 trades + 20 din se pehle verdict "KAM DATA".
- `dhan_flow.js`: Dhan NIFTY futures Full feed (volume delta + best bid/ask + side) = real order flow. Scrip master se current futures ID aur lot size khud nikalta hai, rollover khud. Packet sanity check fail ho to inferred par wapas.
  Pehle din `DEBUG_FLOW=1` chala kar console log dekho. Layout Dhan docs se hai, maine live feed se verify nahi kiya.
- `alerts.js` + `telegram_setup.js`: signal, paper trade close, bada confirmed news, event (60/15 min pehle), feed/chain/token problem. `http://localhost:3000/api/alert/test` se test.
- Futures feed live ho to engine futures price par chalta hai (index se basis ka farak). Kite mode me pehle se aisa hi tha.

# Part 4: Zero-Touch Auto-Login & 1-Click Live Order Punching (25 Oct 2026)
- `dhan_auth.js` (naya): Pure native Node.js TOTP engine (RFC 6238, zero external dependencies). Client ID, Trading PIN aur TOTP secret se automatically roz naya token generate karta hai.
- `dhan_order.js` (naya): Dhan HQ API v2 (`/v2/orders`, `/v2/positions`, `/v2/fundlimit`) ke saath direct integration. 1-click order execution with safety cap (`MAX_ORDER_QTY`), market/limit orders, auto strike resolution.
- `server.js` startup: Agar token expire ho to automatically TOTP auto-login chala kar live connect ho jata hai bina manual copy-paste ke. Scheduled 12-hour auto-renewal with auto-login fallback.
- `quant_engine_live.html`:
  1. Settings modal me "Zero-Touch Automated Login" inputs (PIN + TOTP Secret) aur "⚡ Test Auto-Login Now" button.
  2. "1-Click Live Trade Desk": Mode toggle (Paper vs LIVE DHAN), real-time ATM Call & Put price badges, 1-click execution buttons, live open positions table, live P&L, aur "🚨 Close Positions" emergency square-off button.
- `renew_dhan_token.js`: Support for `--auto` flag aur automatic TOTP auto-login fallback on expired token.

# Part 5: 4 Advanced Institutional Upgrades (27 Oct 2026)
1. **1-Click Direct Strategy Execution (Paper & Live Dhan)**:
   - Actionable Trade Setup Card me `📝 1-Click Paper Buy` aur `🚀 1-Click Live Dhan Buy` buttons direct integration ke sath add hue.
   - Recommended strike, entry price, SL, aur targets automatically paper trade me log ya direct Live Dhan API order punch karte hain.
2. **NIFTY vs BANKNIFTY Sync & Correlation Radar**:
   - Nifty aur Bank Nifty ka real-time percentage change aur price divergence monitor karta hai.
   - States: FULL BULLISH SYNC, FULL BEARISH SYNC, DIVERGENCE (BULL TRAP / BEAR TRAP warning), aur CHOPPY.
   - Tactical Hindi guidance aur sync score % gauge.
3. **Expiry Gamma Explosion & 0DTE Squeeze Detector**:
   - Near-ATM strikes me aggressive short-covering unwinding (OI drop < -40k with high volume) aur gamma acceleration detect karta hai.
   - Top squeeze strike highlight aur 1-click "🎯 Focus Strike" button.
4. **Live ΔPCR Velocity & Institutional Pressure Speedometer**:
   - 1-minute aur 3-minute PCR momentum rate of change track karta hai.
   - Institutional Put/Call addition speed (contracts/min) aur visual speedometer needle (-50 to +50 gauge) ke sath live pressure dikhata hai.

# Part 6: Zero-Lag Modular Architecture (27 Oct 2026)
- **Monolithic `server.js` Refactored:** 4,000 lines ki single monolithic file se heavy engines ko alag-alag modules me divide kar diya gaya hai taaki lag ya glitch ka koi chance na rahe:
  1. `radar_engine.js`: Giants Confluence & Trap Radar, Nifty vs BankNifty Sync Radar, Gamma Blast Squeeze Detector, Live PCR Velocity Speedometer, aur ATM Straddle & Fresh Flow engines.
  2. `cash_market.js`: NIFTY 50 cash constituents weights, live quotes fetching via Dhan marketfeed, aur real-time points contribution logic.
- **Performance & Memory Protection:** Har module me 2.5s sub-second memory caching aur bounded history store (`shift()` on max limit) ensure karta hai ki event loop hamesha responsive rahe aur memory leak na ho.
- **Reliability:** WebSocket server, broker feeds (Dhan/Kite), aur HTTP routing completely isolated hain.

