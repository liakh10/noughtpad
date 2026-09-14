/* Server-side chain access: public client, the operator wallet, curve state and a holder index built from
   Transfer logs. The operator key lives only in the Vercel env var NOUGHT_OPERATOR_KEY. */
import { createPublicClient, createWalletClient, http, fallback, getAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as P from './pons.js';
import { redis } from './store.js';

export const CHAIN = {
  id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'] } }
};
export const pub = createPublicClient({ chain: CHAIN, transport: fallback(CHAIN.rpcUrls.default.http.map(u => http(u, { timeout: 20000 }))) });

let op = null;
export function operator() {
  if (op) return op;
  const key = process.env.NOUGHT_OPERATOR_KEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw Error('The launch operator is not configured yet.');
  const account = privateKeyToAccount(key);
  op = { account, address: account.address, wallet: createWalletClient({ account, chain: CHAIN, transport: http(CHAIN.rpcUrls.default.http[0], { timeout: 30000 }) }) };
  return op;
}
export const operatorAddress = () => { try { return operator().address; } catch { return null; } };

export async function write(req) {
  const o = operator();
  const { request } = await pub.simulateContract({ account: o.account, ...req });
  const hash = await o.wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
  if (receipt.status !== 'success') throw Error('Transaction reverted: ' + hash);
  return { hash, receipt };
}

const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
export async function curveState(curve) {
  const f = n => read(curve, P.CURVE_ABI, n);
  const [[quoteReserve, tokenReserve], feeBps, creatorTaxBps, sellable, graduated, ready, realQuote, threshold, feeBal, taxBal] = await Promise.all([
    f('getReserves'), f('feeBps'), f('creatorTaxBps'), f('sellableTokens'), f('graduated'), f('readyToGraduate'), f('realQuoteReserve'), f('graduationThreshold'), f('quoteFeeBalance'), f('creatorTaxBalance')
  ]);
  return { quoteReserve, tokenReserve, feeBps, creatorTaxBps, sellable, graduated: graduated || ready, realQuote, threshold, feeBal, taxBal, price: P.priceOf({ quoteReserve, tokenReserve }) };
}

/* incremental balance index per token: np:h:<token> = { block, bal: { address: amount } } */
const STEP = 45000n;
export async function holderIndex(token, fromBlock) {
  const R = redis(), key = 'np:h:' + token.toLowerCase();
  const saved = await R.get(key);
  const idx = saved ? JSON.parse(saved) : { block: String(BigInt(fromBlock) - 1n), bal: {} };
  const head = await pub.getBlockNumber();
  let from = BigInt(idx.block) + 1n;
  const bal = Object.fromEntries(Object.entries(idx.bal).map(([a, v]) => [a, BigInt(v)]));
  const transfer = P.TOKEN_ABI.find(x => x.name === 'Transfer');
  let span = STEP;
  while (from <= head) {
    const to = from + span - 1n > head ? head : from + span - 1n;
    let logs;
    try { logs = await pub.getLogs({ address: token, event: transfer, fromBlock: from, toBlock: to }); }
    catch (e) {
      /* the Robinhood RPC returns at most 10,000 logs per query: halve the window and retry */
      if (span > 1n && /exceeds limit|too many|range/i.test(String(e.details || '') + (e.shortMessage || '') + (e.message || ''))) { span /= 2n; continue; }
      throw e;
    }
    if (span < STEP) span *= 2n;
    for (const l of logs) {
      const { from: a, to: b, value } = l.args;
      if (a !== zeroAddress) { bal[a] = (bal[a] || 0n) - value; if (bal[a] <= 0n) delete bal[a]; }
      if (b !== zeroAddress) bal[b] = (bal[b] || 0n) + value;
    }
    from = to + 1n;
  }
  const out = { block: String(head), bal: Object.fromEntries(Object.entries(bal).map(([a, v]) => [a, v.toString()])) };
  await R.set(key, JSON.stringify(out));
  return { block: head, bal };
}

/* eligible holders: externally owned accounts only; curve, pool, escrow, operator and contracts keep their share */
export async function eligible(bal, exclude) {
  const R = redis(), skip = new Set(exclude.filter(Boolean).map(a => a.toLowerCase()));
  const out = [];
  for (const [addr, amount] of Object.entries(bal)) {
    if (skip.has(addr.toLowerCase()) || amount <= 0n) continue;
    const ck = 'np:code:' + addr.toLowerCase();
    let isContract = await R.get(ck);
    if (isContract === null) { const code = await pub.getCode({ address: addr }); isContract = code && code !== '0x' ? '1' : '0'; await R.set(ck, isContract); }
    if (isContract === '1') continue;
    out.push({ address: getAddress(addr), amount });
  }
  return out.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}
