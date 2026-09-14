/* Reward service. Runs every few minutes (GitHub Actions cron with CRON_SECRET, or a page poke at most once
   a minute). Each run advances every token one step:
   1. sweep   creator fees from the Pons curve into the fee escrow, measured per token, then claim to the operator
   2. round   when a token's vault holds ROUND_MIN and the cooldown passed: snapshot holders, quote the reward
              asset on Relay, send one deposit that bridges, buys and pays holders
   3. settle  follow the Relay request until it lands; HYPE is forwarded to holders from the operator */
import { createWalletClient, http as viemHttp, getAddress, parseEther, formatEther } from 'viem';
import * as P from '../lib/pons.js';
import * as RL from '../lib/relay.js';
import { pub, operator, write, curveState, holderIndex, eligible } from '../lib/chain.js';
import { redis, withLocks } from '../lib/store.js';
import { json } from '../lib/http.js';

export const ROUND_MIN = parseEther('0.01');
export const COOLDOWN_S = 600;
const SWEEP_MIN = parseEther('0.0002'), GAS_KEEP = parseEther('0.0004'), MAX_RECIPIENTS = 150, SUPPLY = 10n ** 27n;
const EXCLUDE = [P.FACTORY, P.FEE_ESCROW, '0x8366a39CC670B4001A1121B8F6A443A643e40951', '0x58daec3116aae6D93017bAAea7749052E8a04fA7', '0x000000000000000000000000000000000000dEaD'];
const now = () => Math.floor(Date.now() / 1000);
const loadV = async id => { const s = await redis().get('np:v:' + id); return s ? JSON.parse(s) : { vault: '0', swept: '0', paid: '0', lastRoundAt: 0, round: null, rounds: [] }; };
const saveV = (id, v) => redis().set('np:v:' + id, JSON.stringify(v));

export default async function handler(req, res) {
  const R = redis(), q = req.query || {}, secret = process.env.CRON_SECRET;
  const authed = secret && (req.headers.authorization === 'Bearer ' + secret || q.secret === secret);
  if (!authed && !(await R.set('np:poke', '1', { nx: true, ex: 60 }))) return json(res, 200, { ok: true, skipped: 'recent run' });
  try { operator(); } catch (e) { return json(res, 200, { ok: false, skipped: e.message }); }
  try {
    const log = await withLocks(['operator'], () => run());
    json(res, 200, { ok: true, log });
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function run() {
  const R = redis(), o = operator(), log = [], ids = await R.lrange('np:ts', 0, 199);
  const recs = (await Promise.all(ids.map(id => R.get('np:t:' + id)))).filter(Boolean).map(s => JSON.parse(s));

  /* 1. sweep into the escrow, attributing each delta to its token */
  let swept = false;
  for (const t of recs) {
    const id = t.token.toLowerCase(), c = await curveState(t.curve).catch(() => null);
    if (!c || c.graduated) continue;
    if (c.feeBal + c.taxBal < SWEEP_MIN) continue;
    const before = await pub.readContract({ address: P.FEE_ESCROW, abi: P.ESCROW_ABI, functionName: 'balanceOf', args: [o.address] });
    await write({ address: t.curve, abi: P.CURVE_ABI, functionName: 'sweepFees', args: [0n] });
    const after = await pub.readContract({ address: P.FEE_ESCROW, abi: P.ESCROW_ABI, functionName: 'balanceOf', args: [o.address] });
    const v = await loadV(id), delta = after - before;
    v.vault = (BigInt(v.vault) + delta).toString(); v.swept = (BigInt(v.swept) + delta).toString();
    await saveV(id, v); swept = true; log.push({ token: t.symbol, swept: formatEther(delta) });
  }
  const escrowBal = await pub.readContract({ address: P.FEE_ESCROW, abi: P.ESCROW_ABI, functionName: 'balanceOf', args: [o.address] });
  if (escrowBal > 0n) { await write({ address: P.FEE_ESCROW, abi: P.ESCROW_ABI, functionName: 'claim', args: [] }); log.push({ claimed: formatEther(escrowBal) }); }

  for (const t of recs) {
    const id = t.token.toLowerCase(), v = await loadV(id);
    /* 3. settle a running round */
    if (v.round && ['bridging', 'forward'].includes(v.round.stage)) {
      const r = v.round;
      if (r.stage === 'bridging') {
        const s = await RL.status(r.requestId).catch(() => ({ status: 'unknown' }));
        if (s.status === 'success') { r.destTx = s.dest; r.stage = r.forward ? 'forward' : 'paid'; }
        else if (['failure', 'refund'].includes(s.status)) { r.stage = 'failed'; r.note = 'Relay ' + s.status; v.vault = (BigInt(v.vault) + BigInt(r.amountIn)).toString(); }
      }
      if (r.stage === 'forward') {
        const hl = createWalletClient({ account: o.account, chain: { id: 999, name: 'HyperEVM', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [RL.ROUTES.hyperliquid.rpc] } } }, transport: viemHttp(RL.ROUTES.hyperliquid.rpc) });
        r.sent = r.sent || 0;
        for (; r.sent < r.shares.length; r.sent++) { const s = r.shares[r.sent]; await hl.sendTransaction({ to: s.address, value: BigInt(s.amount) }); }
        r.stage = 'paid';
      }
      if (r.stage === 'paid') await credit(t, r);
      if (r.stage !== v.round.stage || ['paid', 'failed'].includes(r.stage)) log.push({ token: t.symbol, round: r.n, stage: r.stage });
      if (['paid', 'failed'].includes(r.stage)) { v.rounds.unshift(summary(r)); v.rounds = v.rounds.slice(0, 30); if (r.stage === 'paid') v.paid = (BigInt(v.paid) + BigInt(r.total)).toString(); v.round = null; }
      await saveV(id, v);
      continue;
    }

    /* 2. start a round */
    const vault = BigInt(v.vault);
    if (v.round || vault < ROUND_MIN || now() - v.lastRoundAt < COOLDOWN_S) continue;
    const { block, bal } = await holderIndex(t.token, BigInt(t.block));
    const holders = (await eligible(bal, [...EXCLUDE, t.curve, o.address])).slice(0, t.net === 'hyperliquid' && t.asset === 'USDC' ? 40 : MAX_RECIPIENTS);
    if (!holders.length) { log.push({ token: t.symbol, round: 'no eligible holders' }); continue; }
    const eth = vault - GAS_KEEP, { out } = await RL.quoteOut({ net: t.net, asset: t.asset, amountWei: eth, operator: o.address });
    let budget = out * 96n / 100n;
    let shares = holders.map(h => ({ address: h.address, amount: budget * h.amount / SUPPLY, bal: h.amount })).filter(s => s.amount > 0n);
    if (!shares.length) { log.push({ token: t.symbol, round: 'shares round to zero' }); continue; }
    let quote = await RL.payoutQuote({ net: t.net, asset: t.asset, shares, operator: o.address });
    if (quote.amountIn > eth) {
      shares = shares.map(s => ({ ...s, amount: s.amount * eth * 97n / (quote.amountIn * 100n) })).filter(s => s.amount > 0n);
      quote = await RL.payoutQuote({ net: t.net, asset: t.asset, shares, operator: o.address });
      if (quote.amountIn > eth) { log.push({ token: t.symbol, round: 'quote above vault' }); continue; }
    }
    const hash = await o.wallet.sendTransaction({ to: quote.tx.to, data: quote.tx.data, value: quote.tx.value });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
    if (rc.status !== 'success') { log.push({ token: t.symbol, round: 'deposit reverted', hash }); continue; }
    const n = (v.rounds[0] ? v.rounds[0].n : 0) + 1;
    v.vault = (vault - quote.amountIn - rc.gasUsed * rc.effectiveGasPrice).toString();
    v.lastRoundAt = now();
    v.round = { n, t: now(), stage: 'bridging', net: t.net, asset: t.asset, eth: eth.toString(), amountIn: quote.amountIn.toString(), total: quote.total.toString(), requestId: quote.requestId, depositTx: hash, forward: quote.forward, snapshotBlock: block.toString(), holders: holders.length, shares: shares.map(s => ({ address: s.address, amount: s.amount.toString(), bal: s.bal.toString() })) };
    await saveV(id, v);
    log.push({ token: t.symbol, round: n, deposit: hash, eth: formatEther(quote.amountIn), recipients: shares.length });
  }
  return log;
}

async function credit(t, r) {
  const R = redis();
  if (r.credited) return;
  for (const s of r.shares) {
    await R.lpush('np:rw:' + s.address.toLowerCase(), JSON.stringify({ token: t.token, symbol: t.symbol, n: r.n, net: r.net, asset: r.asset, amount: s.amount, t: r.t, destTx: r.destTx || null }));
    await R.ltrim('np:rw:' + s.address.toLowerCase(), 0, 99);
  }
  r.credited = true;
}
const summary = r => ({ n: r.n, t: r.t, stage: r.stage, net: r.net, asset: r.asset, eth: r.eth, amountIn: r.amountIn, total: r.total, recipients: r.shares.length, holders: r.holders, snapshotBlock: r.snapshotBlock, depositTx: r.depositTx, destTx: r.destTx || null, note: r.note || null, top: r.shares.slice(0, 20) });
