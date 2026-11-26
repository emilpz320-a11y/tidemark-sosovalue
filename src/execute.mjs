#!/usr/bin/env node
// Confirm-before-send execution on SoDEX.
//
//   node src/execute.mjs                       preview the top tradable ticket (ephemeral key, never sent)
//   node src/execute.mjs --ticket tm-1a2b3c4d  preview a specific ticket
//   node src/execute.mjs --ticket <id> --confirm <id> --send
//        sign with your SoDEX API key and send to TESTNET. Needs SODEX_API_KEY_PRIVATE_KEY,
//        SODEX_API_KEY_NAME and SODEX_ACCOUNT_ID. --confirm must repeat the ticket id.
//   --preview-out docs/data/execution.json     write the preview for the dashboard
//
// Guards: only AWAITING_CONFIRMATION tickets; exchange filters (tick, step, min qty, min notional);
// LIMIT IOC at the price the desk showed; signature is recovered and checked before anything is sent;
// mainnet sending is refused by this tool.
import { readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { SODEX, orderFromTicket, buildParams, signOrderRequest, recoverSigner } from './sodex-signer.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const NETWORK = 'testnet';
const snapshot = JSON.parse(readFileSync(opt('snapshot') ?? 'docs/data/latest.json', 'utf8'));
const tradable = (snapshot.tickets ?? []).filter((t) => t.status === 'AWAITING_CONFIRMATION' && t.symbol);
const wanted = opt('ticket');
const ticket = wanted ? (snapshot.tickets ?? []).find((t) => t.id === wanted) : tradable.sort((a, b) => b.notional - a.notional)[0];

async function symbolMeta(market, symbol) {
  const res = await fetch(`${SODEX[NETWORK].gateway}/${market}/markets/symbols?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.find((s) => s.name === symbol) ?? null;
}

function marketOf(t) {
  return /SoDEX \w+ perps/.test(t.venue ?? '') ? 'perps' : 'spot';
}

async function main() {
  const generatedAt = new Date().toISOString();
  if (!ticket) {
    const out = { generatedAt, network: NETWORK, status: 'NO_TICKET', note: wanted ? `ticket ${wanted} not found` : 'no AWAITING_CONFIRMATION ticket in this run' };
    finish(out);
    return;
  }
  const market = marketOf(ticket);
  const meta = await symbolMeta(market, ticket.symbol);

  const live = Boolean(process.env.SODEX_API_KEY_PRIVATE_KEY && process.env.SODEX_API_KEY_NAME && process.env.SODEX_ACCOUNT_ID);
  const account = privateKeyToAccount(live ? process.env.SODEX_API_KEY_PRIVATE_KEY : generatePrivateKey());
  const accountID = live ? Number(process.env.SODEX_ACCOUNT_ID) : 0;

  const built = orderFromTicket(ticket, meta, { market });
  const base = {
    generatedAt,
    network: NETWORK,
    ticket: { id: ticket.id, asset: ticket.asset, side: ticket.side, symbol: ticket.symbol, notional: ticket.notional, limitPrice: ticket.limitPrice, slippageBps: ticket.slippageBps },
    market,
    filters: meta && { symbolID: meta.id, tickSize: meta.tickSize, stepSize: meta.stepSize, minQuantity: meta.minQuantity, minNotional: meta.minNotional },
  };
  if (!built.ok) {
    finish({ ...base, status: 'REFUSED', reasons: built.reasons });
    return;
  }

  const params = buildParams({ market, accountID, symbolID: meta.id, orders: [built.order] });
  const req = await signOrderRequest({ account, network: NETWORK, market, params, apiKeyName: live ? process.env.SODEX_API_KEY_NAME : 'preview-key' });
  const recovered = await recoverSigner(req);
  const selfCheck = recovered.toLowerCase() === account.address.toLowerCase();
  if (!selfCheck) throw new Error('signature self-check failed: recovered signer does not match');

  const preview = {
    ...base,
    status: live ? 'SIGNED' : 'SIGNED_PREVIEW',
    keyMode: live ? 'api-key' : 'ephemeral key generated for this preview (not registered, never sent)',
    order: built.order,
    orderNotional: built.notional,
    request: { method: req.method, url: req.url, body: JSON.parse(req.body), headers: { ...req.headers, 'X-API-Sign': `${req.headers['X-API-Sign'].slice(0, 18)}…` } },
    payloadHash: req.payloadHash,
    eip712Domain: req.domain,
    signer: req.signer,
    signatureSelfCheck: selfCheck,
  };

  const send = flag('send');
  if (!send) {
    finish(preview);
    return;
  }
  if (!live) throw new Error('--send needs SODEX_API_KEY_PRIVATE_KEY, SODEX_API_KEY_NAME and SODEX_ACCOUNT_ID');
  if (opt('confirm') !== ticket.id) throw new Error(`--send needs --confirm ${ticket.id} (repeat the ticket id to confirm)`);
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => null);
  const item = Array.isArray(json?.data) ? json.data[0] : json?.data;
  finish({ ...preview, status: json?.code === 0 && (item?.code ?? 0) === 0 ? 'SENT' : 'REJECTED', response: { http: res.status, code: json?.code, item, error: json?.error ?? json?.msg } });
}

function finish(out) {
  const path = opt('preview-out');
  if (path) writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(`execute: ${e.message}`);
  process.exitCode = 1;
});
