/* Reward asset prices in USD. Live from CoinGecko, cached for two minutes in Redis; the last known
   prices are used when the API does not answer. */
import { redis } from './store.js';
const IDS = { ETH: 'ethereum', BNB: 'binancecoin', HYPE: 'hyperliquid', USDC: 'usd-coin', USDT: 'tether' };
const FALLBACK = { ETH: 2500, BNB: 700, HYPE: 80, USDC: 1, USDT: 1 };
let local = null;
export async function prices() {
  const t = Date.now();
  if (local && t - local.t < 60000) return local.px;
  const R = redis();
  let cached = null;
  try { const s = await R.get('nt:px'); if (s) cached = JSON.parse(s); } catch {}
  if (cached && t - cached.t < 120000) { local = cached; return cached.px; }
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' + Object.values(IDS).join(','), { signal: AbortSignal.timeout(2500) });
    const j = await r.json(), px = { src: 'coingecko' };
    for (const [sym, id] of Object.entries(IDS)) { const v = j[id] && j[id].usd; if (!(v > 0)) throw Error('bad price'); px[sym] = v; }
    local = { t, px }; await R.set('nt:px', JSON.stringify(local));
    return px;
  } catch {
    const px = cached ? cached.px : { ...FALLBACK, src: 'fallback' };
    local = { t, px };
    return px;
  }
}
