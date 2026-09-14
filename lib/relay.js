/* Reward delivery through Relay (api.relay.link). One deposit transaction on Robinhood Chain pays for the
   bridge and the swap; on BNB Chain, Base and Ethereum Relay also runs the Disperse call that pays holders,
   so the operator needs no gas there. HYPE on HyperEVM lands on the operator and is paid out in transfers. */
import { encodeFunctionData, erc20Abi } from 'viem';

export const API = 'https://api.relay.link';
export const DISPERSE = '0xD152f549545093347A162Dce210e7293f1452150';
export const ROUTES = {
  bnb: { chainId: 56, rpc: 'https://bsc-rpc.publicnode.com', assets: { BNB: { address: '0x0000000000000000000000000000000000000000', decimals: 18 }, USDT: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 } } },
  base: { chainId: 8453, rpc: 'https://base-rpc.publicnode.com', assets: { ETH: { address: '0x0000000000000000000000000000000000000000', decimals: 18 }, USDC: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } } },
  ethereum: { chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', assets: { ETH: { address: '0x0000000000000000000000000000000000000000', decimals: 18 }, USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 } } },
  hyperliquid: { chainId: 999, rpc: 'https://rpc.hyperliquid.xyz/evm', assets: { HYPE: { address: '0x0000000000000000000000000000000000000000', decimals: 18 }, USDC: { address: '0xb88339cb7199b77e23db6e890353e22632ba630f', decimals: 6 } } }
};
export const EXPLORERS = { 56: 'https://bscscan.com', 8453: 'https://basescan.org', 1: 'https://etherscan.io', 999: 'https://hyperevmscan.io' };
const NATIVE = '0x0000000000000000000000000000000000000000';
const DISPERSE_ABI = [
  { type: 'function', name: 'disperseEther', stateMutability: 'payable', inputs: [{ name: 'recipients', type: 'address[]' }, { name: 'values', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'disperseToken', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'recipients', type: 'address[]' }, { name: 'values', type: 'uint256[]' }], outputs: [] }
];

async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error('Relay: ' + (j.message || j.errorCode || r.status));
  return j;
}

/* how much of the reward asset a given amount of ETH buys right now */
export async function quoteOut({ net, asset, amountWei, operator }) {
  const R = ROUTES[net], A = R.assets[asset];
  const q = await post('/quote', { user: operator, recipient: operator, originChainId: 4663, destinationChainId: R.chainId, originCurrency: NATIVE, destinationCurrency: A.address, tradeType: 'EXACT_INPUT', amount: amountWei.toString() });
  return { out: BigInt(q.details.currencyOut.amount), usd: Number(q.details.currencyOut.amountUsd || 0), impact: q.details.totalImpact && q.details.totalImpact.percent };
}

/* shares: [{ address, amount }] in the asset's smallest unit; returns the deposit tx and request id */
export async function payoutQuote({ net, asset, shares, operator }) {
  const R = ROUTES[net], A = R.assets[asset];
  const total = shares.reduce((s, x) => s + x.amount, 0n);
  const recipients = shares.map(x => x.address), values = shares.map(x => x.amount);
  const body = { user: operator, originChainId: 4663, destinationChainId: R.chainId, originCurrency: NATIVE, destinationCurrency: A.address, tradeType: 'EXACT_OUTPUT', amount: total.toString() };
  if (net === 'hyperliquid' && asset === 'HYPE') {
    body.recipient = operator; /* no batch call on HyperEVM for native HYPE: the operator forwards it */
  } else if (net === 'hyperliquid') {
    body.recipient = operator;
    body.txs = shares.map(x => ({ to: A.address, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [x.address, x.amount] }) }));
  } else if (A.address === NATIVE) {
    body.recipient = operator;
    body.txs = [{ to: DISPERSE, value: total.toString(), data: encodeFunctionData({ abi: DISPERSE_ABI, functionName: 'disperseEther', args: [recipients, values] }) }];
  } else {
    body.recipient = operator;
    body.txs = [
      { to: A.address, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DISPERSE, total] }) },
      { to: DISPERSE, value: '0', data: encodeFunctionData({ abi: DISPERSE_ABI, functionName: 'disperseToken', args: [A.address, recipients, values] }) }
    ];
  }
  const q = await post('/quote', body);
  const step = q.steps && q.steps[0], item = step && step.items && step.items[0];
  if (!item || !item.data || Number(item.data.chainId) !== 4663) throw Error('Relay returned an unexpected route.');
  return { requestId: step.requestId, tx: { to: item.data.to, data: item.data.data, value: BigInt(item.data.value || 0) }, amountIn: BigInt(q.details.currencyIn.amount), total, forward: !body.txs };
}

export async function status(requestId) {
  const r = await fetch(API + '/intents/status/v2?requestId=' + requestId, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  return { status: j.status || 'unknown', txHashes: j.txHashes || [], dest: (j.txHashes || []).slice(-1)[0] || null };
}
