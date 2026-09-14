/* GET /api/tokens            every Noughtpad launch with live curve state and its reward vault
   GET /api/tokens?t=0x…      one token: curve, recent trades, holders, rounds
   add &u=0x…                 the wallet's balance and the rewards it received */
import { getAddress, formatEther } from 'viem';
import * as P from '../lib/pons.js';
import { pub, curveState, holderIndex, operatorAddress } from '../lib/chain.js';
import { redis } from '../lib/store.js';
import { json } from '../lib/http.js';
import { ROUND_MIN, COOLDOWN_S } from './tick.js';

const vaultOf = async id => { const s = await redis().get('np:v:' + id); return s ? JSON.parse(s) : { vault: '0', swept: '0', paid: '0', lastRoundAt: 0, round: null, rounds: [] }; };

export default async function handler(req, res) {
  try {
    const R = redis(), q = req.query || {};
    const user = /^0x[0-9a-fA-F]{40}$/.test(q.u || '') ? getAddress(q.u) : null;
    const out = { operator: operatorAddress(), roundMin: ROUND_MIN, cooldown: COOLDOWN_S, now: Math.floor(Date.now() / 1000) };

    let list = await R.get('np:list');
    if (list) list = JSON.parse(list);
    else {
      const ids = await R.lrange('np:ts', 0, 199);
      const recs = (await Promise.all(ids.map(id => R.get('np:t:' + id)))).filter(Boolean).map(s => JSON.parse(s));
      list = await Promise.all(recs.map(async t => {
        const [c, v] = await Promise.all([curveState(t.curve).catch(() => null), vaultOf(t.token.toLowerCase())]);
        return { ...t, curve: t.curve, state: c && { price: c.price, quoteReserve: c.quoteReserve, tokenReserve: c.tokenReserve, realQuote: c.realQuote, threshold: c.threshold, graduated: c.graduated, pendingFees: c.feeBal + c.taxBal }, vault: v.vault, paid: v.paid, rounds: v.rounds.length + (v.round ? 1 : 0), lastRoundAt: v.lastRoundAt, stage: v.round ? v.round.stage : null };
      }));
      await R.set('np:list', JSON.stringify(list, (k, x) => typeof x === 'bigint' ? x.toString() : x), { ex: 10 });
    }
    out.tokens = list;

    if (q.t && /^0x[0-9a-fA-F]{40}$/.test(q.t)) {
      const id = q.t.toLowerCase(), s = await R.get('np:t:' + id);
      if (!s) throw Error('Token not found on Noughtpad.');
      const t = JSON.parse(s), [c, v] = await Promise.all([curveState(t.curve), vaultOf(id)]);
      const head = await pub.getBlockNumber(), from = BigInt(t.block) > head - 40000n ? BigInt(t.block) : head - 40000n;
      const [buys, sells] = await Promise.all(['CurveBuy', 'CurveSell'].map(name => pub.getLogs({ address: t.curve, event: P.CURVE_ABI.find(x => x.name === name), fromBlock: from, toBlock: head }).catch(() => [])));
      const trades = [...buys, ...sells].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex).slice(-200).map(l => l.eventName === 'CurveBuy'
        ? { side: 'buy', who: l.args.recipient, eth: l.args.quoteIn, tokens: l.args.tokensOut, block: l.blockNumber.toString(), tx: l.transactionHash }
        : { side: 'sell', who: l.args.seller, eth: l.args.quoteOut, tokens: l.args.tokensIn, block: l.blockNumber.toString(), tx: l.transactionHash });
      let holders = [];
      try {
        const { bal } = await holderIndex(t.token, BigInt(t.block));
        holders = Object.entries(bal).map(([address, amount]) => ({ address, amount, curve: address.toLowerCase() === t.curve.toLowerCase() })).sort((a, b) => (b.amount > a.amount ? 1 : -1)).slice(0, 40);
      } catch {}
      out.token = { ...t, state: c, vault: v.vault, swept: v.swept, paid: v.paid, lastRoundAt: v.lastRoundAt, round: v.round && { ...v.round, shares: v.round.shares.slice(0, 20) }, rounds: v.rounds, trades, holders, headBlock: head.toString() };
      if (user) out.token.mine = await pub.readContract({ address: t.token, abi: P.TOKEN_ABI, functionName: 'balanceOf', args: [user] });
    }
    if (user) out.rewards = (await R.lrange('np:rw:' + user.toLowerCase(), 0, 99)).map(x => JSON.parse(x));
    json(res, 200, out);
  } catch (e) { json(res, 400, { error: e.message }); }
}
