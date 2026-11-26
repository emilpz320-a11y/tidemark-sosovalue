// SoDEX order builder and EIP-712 signer.
// Turns a confirmed Tidemark ticket into the exact signed request SoDEX expects
// (docs.sodex.com: "Authentication and signing", "Spot trading", REST v1 schema).
//
// Spot:  POST {gw}/api/v1/spot/trade/orders/batch   action "batchNewOrder", domain "spot"
// Perps: POST {gw}/api/v1/perps/trade/orders        action "newOrder",      domain "futures"
// payloadHash = keccak256(compact JSON of {type, params}); field order follows the Go structs.
// X-API-Sign = 0x01 || EIP-712 signature of ExchangeAction{payloadHash, nonce}.
import { keccak256, toHex, concatHex, recoverTypedDataAddress } from 'viem';

export const SODEX = {
  testnet: { gateway: 'https://testnet-gw.sodex.dev/api/v1', chainId: 138565 },
  mainnet: { gateway: 'https://mainnet-gw.sodex.dev/api/v1', chainId: 286623 },
};

export const SIDE = { BUY: 1, SELL: 2 };
export const ORDER_TYPE = { LIMIT: 1, MARKET: 2 };
export const TIF = { GTC: 1, IOC: 3, GTX: 4 };
const MODIFIER_NORMAL = 1;
const POSITION_SIDE_BOTH = 1;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const CLORD_RE = /^[0-9a-zA-Z_-]{1,36}$/;

const EXCHANGE_ACTION_TYPES = {
  ExchangeAction: [
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
  ],
};

const decimalsOf = (step) => (String(step).split('.')[1] ?? '').replace(/0+$/, '').length;

/**
 * Round `value` to a multiple of `step` (a decimal string such as "0.001"), returning a decimal string.
 * mode: 'floor' | 'ceil' | 'nearest'. Integer arithmetic avoids float noise in the signed payload.
 */
export function roundToStep(value, step, mode = 'floor') {
  const d = decimalsOf(step);
  const scale = 10 ** d;
  const stepInt = Math.round(parseFloat(step) * scale);
  const raw = value * scale;
  const units = raw / stepInt;
  const eps = 1e-9;
  const k = mode === 'ceil' ? Math.ceil(units - eps) : mode === 'nearest' ? Math.round(units) : Math.floor(units + eps);
  return ((k * stepInt) / scale).toFixed(d);
}

/** Deterministic client order id derived from the ticket id (fits ^[0-9a-zA-Z_-]{1,36}$). */
export function clientOrderId(ticketId, suffix = '') {
  const id = `${ticketId}${suffix ? `-${suffix}` : ''}`.replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 36);
  if (!CLORD_RE.test(id)) throw new Error(`invalid clOrdID "${id}"`);
  return id;
}

/**
 * Convert a Tidemark ticket into one SoDEX order, applying the symbol's exchange filters.
 * Only AWAITING_CONFIRMATION tickets are eligible; BLOCKED tickets never become orders.
 * The order is a LIMIT IOC at the ticket's worst book level, so it can never fill worse than the
 * price the desk showed the user.
 */
export function orderFromTicket(ticket, meta, { market, clOrdID } = {}) {
  const reasons = [];
  if (ticket?.status !== 'AWAITING_CONFIRMATION') reasons.push(`ticket status is ${ticket?.status ?? 'missing'}, not AWAITING_CONFIRMATION`);
  if (!meta) reasons.push('symbol not listed on this network');
  else if (meta.status && meta.status !== 'TRADING') reasons.push(`symbol status is ${meta.status}`);
  if (reasons.length) return { ok: false, reasons };

  const side = ticket.side === 'BUY' ? SIDE.BUY : SIDE.SELL;
  // Round the limit in the direction that keeps the IOC marketable but never past the shown worst level by more than one tick.
  const price = roundToStep(ticket.limitPrice, meta.tickSize, side === SIDE.BUY ? 'ceil' : 'floor');
  const quantity = roundToStep(ticket.quantity, meta.stepSize, 'floor');
  const notional = parseFloat(price) * parseFloat(quantity);
  if (parseFloat(quantity) < parseFloat(meta.minQuantity ?? 0)) reasons.push(`quantity ${quantity} below minQuantity ${meta.minQuantity}`);
  if (notional < parseFloat(meta.minNotional ?? 0)) reasons.push(`notional ${notional.toFixed(2)} below minNotional ${meta.minNotional}`);
  if (reasons.length) return { ok: false, reasons };

  const id = clOrdID ?? clientOrderId(ticket.id);
  const order =
    market === 'perps'
      ? { clOrdID: id, modifier: MODIFIER_NORMAL, side, type: ORDER_TYPE.LIMIT, timeInForce: TIF.IOC, price, quantity, reduceOnly: false, positionSide: POSITION_SIDE_BOTH }
      : { symbolID: meta.id, clOrdID: id, side, type: ORDER_TYPE.LIMIT, timeInForce: TIF.IOC, price, quantity };
  return { ok: true, order, notional: Math.round(notional * 100) / 100 };
}

/** Build the request params (HTTP body) with keys in Go-struct order. */
export function buildParams({ market, accountID, symbolID, orders }) {
  if (market === 'perps') return { accountID, symbolID, orders };
  return { accountID, orders };
}

export const actionType = (market) => (market === 'perps' ? 'newOrder' : 'batchNewOrder');
export const domainName = (market) => (market === 'perps' ? 'futures' : 'spot');
export const orderPath = (market) => (market === 'perps' ? '/perps/trade/orders' : '/spot/trade/orders/batch');

export function payloadHashOf(market, params) {
  return keccak256(toHex(JSON.stringify({ type: actionType(market), params })));
}

/**
 * Sign a new-order request. `account` is a viem LocalAccount (the API key's key, or the master wallet).
 * Returns everything needed to send it: url, body string, headers, plus the hash for audit.
 */
export async function signOrderRequest({ account, network = 'testnet', market, params, nonce = BigInt(Date.now()), apiKeyName }) {
  const net = SODEX[network];
  if (!net) throw new Error(`unknown network ${network}`);
  const payloadHash = payloadHashOf(market, params);
  const domain = { name: domainName(market), version: '1', chainId: net.chainId, verifyingContract: ZERO_ADDRESS };
  const signature = await account.signTypedData({ domain, types: EXCHANGE_ACTION_TYPES, primaryType: 'ExchangeAction', message: { payloadHash, nonce } });
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-API-Nonce': nonce.toString(),
    'X-API-Sign': concatHex(['0x01', signature]),
  };
  if (apiKeyName) headers['X-API-Key'] = apiKeyName; // the key NAME, not its address; omit to sign with the master wallet
  return {
    url: `${net.gateway}${orderPath(market)}`,
    method: 'POST',
    body: JSON.stringify(params),
    headers,
    payloadHash,
    domain,
    signer: account.address,
  };
}

/** Recover the signer from a signed request (used by tests and as a pre-send self-check). */
export async function recoverSigner(req) {
  const typed = req.headers['X-API-Sign'];
  const signature = `0x${typed.slice(4)}`; // strip the 0x01 type byte
  return recoverTypedDataAddress({
    domain: req.domain,
    types: EXCHANGE_ACTION_TYPES,
    primaryType: 'ExchangeAction',
    message: { payloadHash: req.payloadHash, nonce: BigInt(req.headers['X-API-Nonce']) },
    signature,
  });
}
