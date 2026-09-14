/* Noughtpad engine. A Pons-style bonding curve traded with play ETH, a 3% trading fee, a creator vault
   and reward rounds that pay holders of a token in an asset on another network.
   All amounts are bigint with 18 decimals. Shared by the API (authoritative) and the page (quotes). */
export const WEI = 10n ** 18n;
export const SUPPLY = 1000000000n * WEI;
export const CURVE_TOKENS = 793100000n * WEI;
export const V_ETH0 = 4n * WEI, V_TOK0 = 1073000000n * WEI;
export const FEE_BPS = 300n, CREATOR_BPS = 200n, BRIDGE_BPS = 50n;
export const MIN_ETH = WEI / 10000n;
export const THRESHOLD = 4n * WEI / 1000n;
export const CHECK_S = 30, COOLDOWN_S = 180;
export const STAGES = [['collect', 0], ['bridge', 8], ['buy', 22], ['paid', 34]];
export const NETS = {
  bnb: { name: 'BNB Chain', color: '#f3ba2f', assets: ['BNB', 'USDT'] },
  base: { name: 'Base', color: '#2f6bff', assets: ['ETH', 'USDC'] },
  ethereum: { name: 'Ethereum', color: '#8c93ff', assets: ['ETH', 'USDC'] },
  hyperliquid: { name: 'Hyperliquid', color: '#58e1c1', assets: ['HYPE', 'USDC'] }
};

export const ceilDiv = (a, b) => (a + b - 1n) / b;
export function toWei(v, label = 'Amount') {
  const s = String(v).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(s)) throw Error(label + ' must be a positive number.');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * WEI + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
export function fromWei(w, dp = 6) {
  w = BigInt(w); const neg = w < 0n; if (neg) w = -w;
  const i = w / WEI, f = (w % WEI).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
}
export const price = M => M.vEth * WEI / M.vTok;

/* curve */
export function quoteBuy(M, ethIn) {
  let gross = BigInt(ethIn);
  if (gross < MIN_ETH) throw Error('Minimum buy is 0.0001 ETH.');
  const left = CURVE_TOKENS - M.sold;
  if (left <= 0n) throw Error('The curve is complete.');
  let fee = ceilDiv(gross * FEE_BPS, 10000n), net = gross - fee, out = M.vTok * net / (M.vEth + net);
  if (out > left) {
    out = left; net = ceilDiv(M.vEth * left, M.vTok - left);
    gross = ceilDiv(net * 10000n, 10000n - FEE_BPS); fee = gross - net;
  }
  return { gross, fee, net, out };
}
export function quoteSell(M, tokIn) {
  tokIn = BigInt(tokIn);
  if (tokIn <= 0n) throw Error('Enter an amount to sell.');
  let raw = M.vEth * tokIn / (M.vTok + tokIn);
  if (raw > M.realEth) raw = M.realEth;
  const fee = ceilDiv(raw * FEE_BPS, 10000n);
  if (raw - fee <= 0n) throw Error('Sell amount too small.');
  return { tokIn, raw, fee, out: raw - fee };
}
function takeFee(M, fee) { const c = fee * CREATOR_BPS / FEE_BPS; M.vault += c; M.protocol += fee - c; M.fees += fee; }
function trade(M, tr) { M.trades.push(tr); if (M.trades.length > 400) M.trades.splice(0, M.trades.length - 400); }

export function buy(M, P, ethIn, now) {
  const q = quoteBuy(M, ethIn);
  if (P.wallet < q.gross) throw Error('Not enough play ETH.');
  const before = price(M);
  P.wallet -= q.gross; M.vEth += q.net; M.vTok -= q.out; M.realEth += q.net; M.sold += q.out; M.volume += q.net;
  M.holders[P.pid] = (M.holders[P.pid] || 0n) + q.out;
  takeFee(M, q.fee);
  if (!P.tokens.includes(M.id)) P.tokens.unshift(M.id);
  trade(M, { t: now, side: 'buy', eth: q.gross, tok: q.out, before, after: price(M), pid: P.pid });
  return q;
}
export function sell(M, P, tokIn, now) {
  const bal = M.holders[P.pid] || 0n; tokIn = BigInt(tokIn);
  if (tokIn > bal) throw Error('You do not hold that many tokens.');
  const q = quoteSell(M, tokIn), before = price(M);
  M.vEth -= q.raw; M.vTok += tokIn; M.realEth -= q.raw; M.sold -= tokIn; M.volume += q.raw; P.wallet += q.out;
  if (bal - tokIn > 0n) M.holders[P.pid] = bal - tokIn;
  else { delete M.holders[P.pid]; P.tokens = P.tokens.filter(x => x !== M.id); }
  takeFee(M, q.fee);
  trade(M, { t: now, side: 'sell', eth: q.out, tok: tokIn, before, after: price(M), pid: P.pid });
  return q;
}

/* reward service */
export const stageOf = (r, now) => STAGES.reduce((s, [k, at]) => now - r.t >= at ? k : s, 'collect');
export const assetToUnits = (eth, ethUsd, assetUsd) => eth * BigInt(Math.round(ethUsd * 1e8)) / BigInt(Math.round(assetUsd * 1e8));
export const isDue = (M, now) => now - M.lastCheck >= CHECK_S && M.vault >= THRESHOLD && now - M.lastRoundAt >= COOLDOWN_S;
export function runService(M, now, px) {
  if (now - M.lastCheck < CHECK_S) return null;
  M.lastCheck = now;
  if (M.vault < THRESHOLD || now - M.lastRoundAt < COOLDOWN_S) return null;
  const eth = M.vault, cost = ceilDiv(eth * BRIDGE_BPS, 10000n), ethUsd = px.ETH, assetUsd = px[M.asset];
  const amount = assetToUnits(eth - cost, ethUsd, assetUsd);
  const list = Object.entries(M.holders)
    .map(([pid, bal]) => ({ pid, bal, amt: amount * bal / SUPPLY }))
    .filter(x => x.amt > 0n)
    .sort((a, b) => b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0);
  const paid = list.reduce((s, x) => s + x.amt, 0n);
  M.vault = 0n; M.lastRoundAt = now; M.roundN += 1; M.paidTotal += paid;
  for (const x of list) M.paidEver[x.pid] = 1;
  const r = { n: M.roundN, t: now, eth, cost, asset: M.asset, net: M.net, ethUsd, assetUsd, amount, paid, retained: amount - paid, wallets: list.length, top: list.slice(0, 25) };
  M.rounds.push(r); if (M.rounds.length > 30) M.rounds.splice(0, M.rounds.length - 30);
  return { r, list };
}

/* storage */
export const pack = o => JSON.stringify(o, (k, v) => typeof v === 'bigint' ? '~b' + v : v);
export const unpack = s => JSON.parse(s, (k, v) => typeof v === 'string' && /^~b-?\d+$/.test(v) ? BigInt(v.slice(2)) : v);
export function newToken({ id, name, sym, desc, x, img, net, asset, creator, now }) {
  if (!NETS[net]) throw Error('Choose a reward network.');
  if (!NETS[net].assets.includes(asset)) throw Error('Choose a reward asset on ' + NETS[net].name + '.');
  return {
    id, name, sym, desc, x, img, net, asset, creator, createdAt: now,
    vEth: V_ETH0, vTok: V_TOK0, realEth: 0n, sold: 0n, vault: 0n, protocol: 0n, fees: 0n, volume: 0n, paidTotal: 0n,
    holders: {}, trades: [], rounds: [], roundN: 0, lastCheck: now, lastRoundAt: 0, paidEver: {}
  };
}
