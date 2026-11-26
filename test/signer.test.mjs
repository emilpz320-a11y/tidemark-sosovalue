import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { roundToStep, orderFromTicket, buildParams, payloadHashOf, signOrderRequest, recoverSigner, clientOrderId } from '../src/sodex-signer.mjs';

const KEY = '0x' + '22'.repeat(32);
const spotMeta = { id: 3, name: 'vMAG7ssi_vUSDC', status: 'TRADING', tickSize: '0.0001', stepSize: '0.01', minQuantity: '0.01', minNotional: '5' };
const perpMeta = { id: 1, name: 'BTC-USD', status: 'TRADING', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', minNotional: '10' };
const ticket = (over = {}) => ({ id: 'tm-1a2b3c4d', status: 'AWAITING_CONFIRMATION', side: 'BUY', symbol: 'vMAG7ssi_vUSDC', limitPrice: 1.234567, quantity: 40.123456, notional: 50, ...over });

test('roundToStep floors, ceils and keeps the step decimals', () => {
  assert.equal(roundToStep(40.123456, '0.01', 'floor'), '40.12');
  assert.equal(roundToStep(1.234567, '0.0001', 'ceil'), '1.2346');
  assert.equal(roundToStep(97123.6, '1', 'floor'), '97123');
  assert.equal(roundToStep(0.3, '0.1', 'floor'), '0.3'); // no float noise (0.30000000000000004)
  assert.equal(roundToStep(0.00123456, '0.00001', 'floor'), '0.00123');
});

test('spot order keeps Go-struct field order and decimal strings', () => {
  const r = orderFromTicket(ticket(), spotMeta, { market: 'spot' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.order), ['symbolID', 'clOrdID', 'side', 'type', 'timeInForce', 'price', 'quantity']);
  assert.equal(r.order.price, '1.2346');
  assert.equal(r.order.quantity, '40.12');
  assert.equal(r.order.timeInForce, 3); // IOC
  assert.equal(typeof r.order.price, 'string');
});

test('perps order uses the PerpsOrderItem field order with BOTH position side', () => {
  const r = orderFromTicket(ticket({ symbol: 'BTC-USD', side: 'SELL', limitPrice: 97123.6, quantity: 0.0012345, notional: 120 }), perpMeta, { market: 'perps' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.order), ['clOrdID', 'modifier', 'side', 'type', 'timeInForce', 'price', 'quantity', 'reduceOnly', 'positionSide']);
  assert.equal(r.order.side, 2);
  assert.equal(r.order.price, '97123'); // SELL limit floors to tick
  assert.equal(r.order.positionSide, 1);
});

test('blocked, unlisted, halted or too-small tickets never become orders', () => {
  assert.equal(orderFromTicket(ticket({ status: 'BLOCKED' }), spotMeta, { market: 'spot' }).ok, false);
  assert.equal(orderFromTicket(ticket(), null, { market: 'spot' }).ok, false);
  assert.equal(orderFromTicket(ticket(), { ...spotMeta, status: 'HALT' }, { market: 'spot' }).ok, false);
  const small = orderFromTicket(ticket({ quantity: 3 }), spotMeta, { market: 'spot' });
  assert.equal(small.ok, false);
  assert.match(small.reasons[0], /minNotional/);
});

test('payloadHash is keccak256 of the compact {type, params} JSON', () => {
  const params = buildParams({ market: 'spot', accountID: 7, orders: [orderFromTicket(ticket(), spotMeta, { market: 'spot' }).order] });
  const expected = keccak256(toHex(JSON.stringify({ type: 'batchNewOrder', params })));
  assert.equal(payloadHashOf('spot', params), expected);
  assert.match(JSON.stringify(params), /^\{"accountID":7,"orders":\[\{"symbolID":3,"clOrdID":"tm-1a2b3c4d","side":1,"type":1,"timeInForce":3,"price":"1.2346","quantity":"40.12"\}\]\}$/);
});

test('signed request: 0x01-typed signature that recovers to the signing key, spot and perps domains', async () => {
  const account = privateKeyToAccount(KEY);
  const params = buildParams({ market: 'spot', accountID: 7, orders: [orderFromTicket(ticket(), spotMeta, { market: 'spot' }).order] });
  const req = await signOrderRequest({ account, market: 'spot', params, nonce: 1760373925001n, apiKeyName: 'tidemark-01' });
  assert.equal(req.url, 'https://testnet-gw.sodex.dev/api/v1/spot/trade/orders/batch');
  assert.equal(req.headers['X-API-Key'], 'tidemark-01');
  assert.equal(req.headers['X-API-Nonce'], '1760373925001');
  assert.match(req.headers['X-API-Sign'], /^0x01[0-9a-f]{130}$/);
  assert.equal(req.domain.name, 'spot');
  assert.equal(req.domain.chainId, 138565);
  assert.equal((await recoverSigner(req)).toLowerCase(), account.address.toLowerCase());

  const preq = await signOrderRequest({ account, market: 'perps', params: buildParams({ market: 'perps', accountID: 7, symbolID: 1, orders: [] }), nonce: 1n });
  assert.equal(preq.domain.name, 'futures');
  assert.ok(preq.url.endsWith('/perps/trade/orders'));
  assert.equal(preq.headers['X-API-Key'], undefined); // master-wallet mode omits the header
});

test('signatures are deterministic for the same key, payload and nonce', async () => {
  const account = privateKeyToAccount(KEY);
  const params = { accountID: 1, orders: [] };
  const a = await signOrderRequest({ account, market: 'spot', params, nonce: 5n });
  const b = await signOrderRequest({ account, market: 'spot', params, nonce: 5n });
  const c = await signOrderRequest({ account, market: 'spot', params, nonce: 6n });
  assert.equal(a.headers['X-API-Sign'], b.headers['X-API-Sign']);
  assert.notEqual(a.headers['X-API-Sign'], c.headers['X-API-Sign']);
});

test('clOrdID is derived from the ticket id and respects the exchange pattern', () => {
  assert.equal(clientOrderId('tm-1a2b3c4d'), 'tm-1a2b3c4d');
  assert.equal(clientOrderId('tm-1a2b3c4d', 'retry1'), 'tm-1a2b3c4d-retry1');
  assert.equal(clientOrderId('tm:bad id!'), 'tmbadid');
});
