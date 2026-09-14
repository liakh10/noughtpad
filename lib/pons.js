/* Pons V2 on Robinhood Chain mainnet: addresses, ABI fragments and curve math.
   Source: github.com/ponsdotdev/ponsfamily contractsV2, verified against chain 4663.
   Plain ES module with no imports so both the API and the page can use it. */
export const CHAIN_ID = 4663;
export const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const FEE_ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const NATIVE = '0x0000000000000000000000000000000000000000';
export const LAUNCH_CONFIG_ID = 0n;
export const CREATOR_TAX_BPS = 200; /* 2% to the Noughtpad vault, on top of the 1% Pons curve fee */
export const BPS = 10000n;

export const FACTORY_ABI = [
  { type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'previewLaunchEconomics', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function', name: 'getLaunchConfig', stateMutability: 'view', inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'tuple', components: [{ name: 'supply', type: 'uint256' }, { name: 'curveFeeBps', type: 'uint256' }, { name: 'phantomQuote', type: 'uint256' }, { name: 'graduationThreshold', type: 'uint256' }, { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'enabled', type: 'bool' }] }]
  },
  {
    type: 'function', name: 'getLaunchedToken', stateMutability: 'view', inputs: [{ type: 'address' }],
    outputs: [{ type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }, { name: 'deployer', type: 'address' }, { name: 'creatorFeeRecipient', type: 'address' }, { name: 'pairToken', type: 'address' }, { name: 'graduationThreshold', type: 'uint256' }, { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'creatorTaxBps', type: 'uint16' }, { name: 'buybackEnabled', type: 'bool' }, { name: 'phase', type: 'uint8' }, { name: 'sweptQuote', type: 'uint256' }, { name: 'sweptTokens', type: 'uint256' }, { name: 'sweptAt', type: 'uint256' }, { name: 'exists', type: 'bool' }] }]
  },
  {
    type: 'function', name: 'launchToken', stateMutability: 'payable',
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
        { name: 'socials', type: 'tuple', components: [{ name: 'twitter', type: 'string' }, { name: 'telegram', type: 'string' }, { name: 'discord', type: 'string' }, { name: 'website', type: 'string' }, { name: 'farcaster', type: 'string' }] },
        { name: 'creatorFeeRecipient', type: 'address' }, { name: 'creatorTaxBps', type: 'uint16' }, { name: 'buybackEnabled', type: 'bool' },
        { name: 'expectedEconomics', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }
      ] },
      { name: 'launchConfigId', type: 'uint256' }, { name: 'pairToken', type: 'address' }
    ],
    outputs: [{ name: 'token', type: 'address' }, { name: 'curve', type: 'address' }]
  },
  { type: 'event', name: 'TokenLaunched', inputs: [{ name: 'token', type: 'address', indexed: true }, { name: 'curve', type: 'address', indexed: true }, { name: 'deployer', type: 'address', indexed: true }, { name: 'pairToken', type: 'address' }, { name: 'launchConfigId', type: 'uint256' }, { name: 'graduationThreshold', type: 'uint256' }] }
];

const v = (name, out = 'uint256') => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: out }] });
export const CURVE_ABI = [
  v('token', 'address'), v('deployer', 'address'), v('feeBps'), v('creatorTaxBps'), v('graduationThreshold'), v('phantomQuote'),
  v('quoteFeeBalance'), v('creatorTaxBalance'), v('buybackQuoteBalance'), v('trackedQuote'), v('trackedTokens'), v('reservedTokens'),
  v('sellableTokens'), v('realQuoteReserve'), v('graduated', 'bool'), v('readyToGraduate', 'bool'), v('protocolFeeShareBps', 'uint16'),
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ name: 'quoteReserve', type: 'uint256' }, { name: 'tokenReserve', type: 'uint256' }] },
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [{ name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [{ name: 'tokensOut', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ name: 'tokensIn', type: 'uint256' }, { name: 'minQuoteOut', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [{ name: 'quoteOut', type: 'uint256' }] },
  { type: 'function', name: 'sweepFees', stateMutability: 'nonpayable', inputs: [{ name: 'minBuybackTokensOut', type: 'uint256' }], outputs: [] },
  { type: 'event', name: 'CurveBuy', inputs: [{ name: 'buyer', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'quoteIn', type: 'uint256' }, { name: 'tokensOut', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'tax', type: 'uint256' }] },
  { type: 'event', name: 'CurveSell', inputs: [{ name: 'seller', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'tokensIn', type: 'uint256' }, { name: 'quoteOut', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'tax', type: 'uint256' }] },
  { type: 'event', name: 'FeesSwept', inputs: [{ name: 'protocolAmount', type: 'uint256' }, { name: 'buybackAmount', type: 'uint256' }, { name: 'creatorAmount', type: 'uint256' }] }
];

export const TOKEN_ABI = [
  v('name', 'string'), v('symbol', 'string'), v('logo', 'string'), v('description', 'string'), v('totalSupply'), v('decimals', 'uint8'),
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256' }] }
];

export const ESCROW_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'amount', type: 'uint256' }] }
];

/* curve math, mirrors PonsV2BondingCurve.buy / sell and PonsV2BondingCurveMath */
const amountOut = (inp, rIn, rOut) => inp * BPS * rOut / (rIn * BPS + inp * BPS);
export function quoteBuy(c, quoteIn) {
  quoteIn = BigInt(quoteIn);
  const fee = quoteIn * c.feeBps / BPS, tax = quoteIn * c.creatorTaxBps / BPS;
  let out = amountOut(quoteIn - fee - tax, c.quoteReserve, c.tokenReserve), spent = quoteIn;
  const sellable = c.sellable;
  if (out > sellable) { out = sellable; const net = sellable * c.quoteReserve * BPS / ((c.tokenReserve - sellable) * BPS) + 1n; spent = (net * BPS + (BPS - c.feeBps - c.creatorTaxBps) - 1n) / (BPS - c.feeBps - c.creatorTaxBps); if (spent > quoteIn) spent = quoteIn; }
  const after = { q: c.quoteReserve + spent - spent * (c.feeBps + c.creatorTaxBps) / BPS, t: c.tokenReserve - out };
  return { spent, fee: spent * c.feeBps / BPS, tax: spent * c.creatorTaxBps / BPS, out, refund: quoteIn - spent, priceAfter: after.t > 0n ? after.q * 10n ** 18n / after.t : 0n };
}
export function quoteSell(c, tokensIn) {
  tokensIn = BigInt(tokensIn);
  const gross = amountOut(tokensIn, c.tokenReserve, c.quoteReserve), fee = gross * c.feeBps / BPS, tax = gross * c.creatorTaxBps / BPS;
  return { gross, fee, tax, out: gross - fee - tax };
}
export const priceOf = c => c.tokenReserve > 0n ? c.quoteReserve * 10n ** 18n / c.tokenReserve : 0n;
export const withSlippage = (x, bps = 300n) => x * (BPS - bps) / BPS;
