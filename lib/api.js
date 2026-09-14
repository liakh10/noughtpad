import crypto from 'node:crypto';
import * as E from './engine.js';
import { redis, withLocks } from './store.js';
import { prices } from './prices.js';
export const now = () => Math.floor(Date.now() / 1000);
export function pidOf(secret) {
  if (!/^[a-f0-9]{32}$/.test(String(secret || ''))) throw Error('Missing wallet key.');
  return crypto.createHash('sha256').update('nought:' + secret).digest('hex').slice(0, 16);
}
export async function loadPlayer(pid, create) {
  const s = await redis().get('nt:p:' + pid);
  if (s) return E.unpack(s);
  if (!create) return null;
  return { pid, wallet: 10n * E.WEI, faucetAt: now(), created: now(), tokens: [], fresh: true };
}
export async function savePlayer(P) { const { fresh, ...rest } = P; await redis().set('nt:p:' + P.pid, E.pack(rest)); }
export async function loadToken(id) { const s = await redis().get('nt:t:' + id); if (!s) throw Error('Token not found.'); return E.unpack(s); }
export async function saveToken(M) {
  const R = redis();
  await R.set('nt:t:' + M.id, E.pack(M));
  await R.set('nt:s:' + M.id, E.pack(summary(M)));
}
export function playerView(P) { return P ? { pid: P.pid, wallet: P.wallet, faucetAt: P.faucetAt, tokens: P.tokens } : null; }

export function summary(M) {
  const p = E.price(M), t = now(), day = M.trades.filter(x => x.t >= t - 86400);
  const open = day.length ? day[0].before : p;
  return {
    id: M.id, name: M.name, sym: M.sym, img: M.img, net: M.net, asset: M.asset, creator: M.creator, createdAt: M.createdAt,
    price: p, realEth: M.realEth, sold: M.sold, vault: M.vault, fees: M.fees, paidTotal: M.paidTotal,
    vol24: day.reduce((s, x) => s + x.eth, 0n), change24: day.length && open > 0n ? Number((p - open) * 10000n / open) / 100 : null,
    holders: Object.keys(M.holders).length, rounds: M.roundN, lastRoundAt: M.lastRoundAt, lastCheck: M.lastCheck, wallets: Object.keys(M.paidEver).length
  };
}
export function tokenView(M, pid, t) {
  const last = M.rounds[M.rounds.length - 1] || null, total = Object.values(M.holders).reduce((s, b) => s + b, 0n);
  const holders = Object.entries(M.holders).map(([id, bal]) => ({ pid: id, bal, mine: id === pid, creator: id === M.creator }))
    .sort((a, b) => b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0).slice(0, 40);
  return {
    ...summary(M), desc: M.desc, x: M.x, vEth: M.vEth, vTok: M.vTok, protocol: M.protocol, volume: M.volume,
    trades: M.trades.slice(-240), rounds: M.rounds.slice(-12).reverse(), holders, heldTotal: total,
    mine: pid ? (M.holders[pid] || 0n) : 0n,
    service: {
      nextCheck: Math.max(0, M.lastCheck + E.CHECK_S - t),
      cooldown: Math.max(0, M.lastRoundAt + E.COOLDOWN_S - t),
      stage: last ? E.stageOf(last, t) : null, lastRound: last ? last.n : 0
    }
  };
}

/* the reward service runs whenever a due token is read or traded */
export async function tick(id, t) {
  return withLocks(['t:' + id], async () => {
    const M = await loadToken(id), before = M.lastCheck;
    if (t - M.lastCheck < E.CHECK_S) return null;
    const px = await prices(), res = E.runService(M, t, px);
    if (res) {
      const R = redis(), arrive = t + E.STAGES[E.STAGES.length - 1][1];
      for (const x of res.list) {
        if (x.pid.startsWith('house')) continue;
        await R.lpush('nt:rw:' + x.pid, E.pack({ id: M.id, sym: M.sym, n: res.r.n, asset: M.asset, net: M.net, amt: x.amt, usd: res.r.assetUsd, at: arrive }));
        await R.ltrim('nt:rw:' + x.pid, 0, 99);
      }
    }
    if (res || M.lastCheck !== before) await saveToken(M);
    return res;
  });
}

export async function seed() {
  const R = redis();
  if (await R.llen('nt:ts')) return;
  await withLocks(['seed'], async () => {
    if (await R.llen('nt:ts')) return;
    const t = now() - 600;
    const list = [
      { id: 'donut', name: 'Donut', sym: 'DONUT', net: 'bnb', asset: 'BNB', desc: 'A hole in the middle and rewards around it', buys: ['0.35', '0.15', '0.06'] },
      { id: 'zero', name: 'Zero Dog', sym: 'ZERO', net: 'hyperliquid', asset: 'HYPE', desc: 'He found a zero and will not give it back', buys: ['0.5', '0.2'] },
      { id: 'ring', name: 'Ring Frog', sym: 'RING', net: 'base', asset: 'ETH', desc: 'Sherwood frog, lives inside the nought', buys: ['0.4', '0.25', '0.1'] }
    ];
    for (const x of list) {
      const M = E.newToken({ ...x, img: '/assets/tok/' + x.id + '.webp', x: '', creator: 'house0', now: t });
      x.buys.forEach((eth, i) => E.buy(M, { pid: 'house' + i, wallet: 100n * E.WEI, tokens: [] }, E.toWei(eth), t + 60 * i));
      M.lastCheck = t;
      await saveToken(M); await R.lpush('nt:ts', M.id);
    }
  });
}

export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v));
}
export const ipOf = req => String(req.headers['x-forwarded-for'] || 'local').split(',')[0].trim();
