# NIFTY 50 Playbook (step by step)

Yeh playbook engine ke saath chalta hai. Isse "jeet ki guarantee" nahi milti. Maqsad hai kharab trades kam karna aur sirf wahi trade lena jahan costs ke baad bhi gunjaish ho.

## A. Go-live se pehle (ek baar)
1. `server.js` market hours mein roz chalao. Wo `ticks-YYYY-MM-DD.ndjson` record karta hai.
2. 20+ trading din ka data jama hone do (10 minimum).
3. `node strategy_lab.js` chalao (ya `RUN_LAB.bat`). Wo 8 variants ko test + stress test karta hai.
4. Agar koi variant "PROVEN (so far)" na ho, to real paisa mat lagao. Paper trade karte raho.
5. Jo variant PROVEN/PROMISING aaye, usko aane wale NAYE dinon par kam se kam 30 din paper trade karo.
6. Sirf tab real: 1 lot se shuru, risk 0.5% se kam ya barabar.

## B. Roz subah (9:00 se pehle)
1. Naya Dhan access token (token roz badalta hai). `.env` mein daalo, `RUN_LIVE.bat` chalao.
2. Page par **Data health**: Order flow, GEX aur Execution "real" hona chahiye. "limited" dikhe to us din trade mat karo.
3. Aaj ke events dekho (RBI, budget, bade results, global shock). Aise din size aadha ya trade nahi.

## C. Din ke dauran
| Time | Kya karna hai |
|---|---|
| 9:15 se 9:25 | Kuch mat kharido (engine bhi block karta hai). Sirf dekho: Market Bias, gamma regime. |
| 9:25 se 10:15 | IB ban raha hai. Sirf "BUY NOW + WITH TREND" aur A/B grade. Warna wait. |
| 10:15 se 14:55 | Trade Desk dekho. Sirf **BUY NOW** card. **AGAINST TREND** card ko ignore karo. |
| 14:55 ke baad | Naya trade nahi. Position 15:15 tak band. |

## D. Ek trade ka step-by-step
1. Market Bias dekho (BULLISH ya BEARISH). Trade usi taraf: bullish mein Call, bearish mein Put.
2. Card par **BUY NOW** aaye tabhi. "WAIT FOR TRIGGER" ya "LATE" par nahi.
3. Order **limit** mein, card ke Entry price par. Chase mat karo.
4. Order ke turant baad **premium stop** laga do. NIFTY stop level par alert rakho. Jo pehle lage, nikal jao.
5. T1 par aadha book karo. Baaki ka stop entry par le aao. T2 tak chhodo.
6. Time stop: 15 minute mein 0.3R progress na ho to nikal jao.
7. Stop kabhi door mat khiskao.

## E. Roz ke limits (engine bhi lagu karta hai)
- Ek trade mein capital ka 0.5% risk.
- Din mein max 3 trade (Risk and filters mein set karo).
- Din ka loss limit 2R. Ye lag jaye to us din band.
- 2 loss ke baad engine 30 minute rukta hai. Isko todna mat.

## F. Roz shaam
1. Trade journal (CSV) copy karke apni sheet mein rakho.
2. Har trade par ek line: kya sahi gaya, kya galat. Dhyan rakho ki rules todke liya trade kaun sa tha.

## G. Har hafte
1. `node strategy_lab.js` dobara chalao (naye din judne ke saath).
2. Settings tabhi badlo jab lab ka TEST + stress result support kare. Ek bure hafte ke baad settings mat badlo.

## H. Kab bilkul trade nahi
- Data health "limited".
- Daily loss limit lag chuka.
- Expiry din ki dopahar (time decay bahut tez).
- Aap thake, gusse mein ya haare hue paise wapas lena chahte ho.
