// Thin, dependency-free clients for the SoSoValue OpenAPI and the public SoDEX gateway.

const SOSO_BASE = 'https://openapi.sosovalue.com/openapi';
const SODEX_BASE = {
  mainnet: 'https://mainnet-gw.sodex.dev/api/v1',
  testnet: 'https://testnet-gw.sodex.dev/api/v1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { headers = {}, retries = 2, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return body;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw new Error(`GET ${url.replace(/\?.*/, '')} failed: ${lastErr?.message}`);
}

export function createSoSoValue(apiKey, { base = SOSO_BASE } = {}) {
  if (!apiKey) throw new Error('SOSO_API_KEY is missing');
  const headers = { 'x-soso-api-key': apiKey, accept: 'application/json' };
  let calls = 0;

  async function get(path, params = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
    ).toString();
    calls++;
    const body = await getJson(`${base}${path}${qs ? `?${qs}` : ''}`, { headers });
    if (body.code !== 0) throw new Error(`SoSoValue ${path}: ${body.code} ${body.message}`);
    return body.data;
  }

  return {
    get callCount() {
      return calls;
    },
    marketOverview: () => get('/v1/market/overview'),
    currencies: () => get('/v1/currencies'),
    currencySnapshot: (id) => get(`/v1/currencies/${id}/market-snapshot`),
    sectorSpotlight: () => get('/v1/currencies/sector-spotlight'),
    etfFlows: (symbol, limit = 30) =>
      get('/v1/etfs/summary-history', { symbol, country_code: 'US', limit }),
    indices: () => get('/v1/indices'),
    indexSnapshot: (ticker) => get(`/v1/indices/${ticker}/market-snapshot`),
    indexConstituents: (ticker) => get(`/v1/indices/${ticker}/constituents`),
    news: (currencyId, pageSize = 20) =>
      get('/v1/news', { currency_id: currencyId, page_size: pageSize }),
    hotNews: (pageSize = 20) => get('/v1/news/hot', { page_size: pageSize }),
    macroEvents: () => get('/v1/macro/events'),
    fomc: () => get('/v1/macro/fomc-probabilities'),
  };
}

export function createSoDex(network = 'mainnet') {
  const base = SODEX_BASE[network];
  if (!base) throw new Error(`Unknown SoDEX network: ${network}`);
  async function get(path) {
    const body = await getJson(`${base}${path}`);
    if (body.code !== 0) throw new Error(`SoDEX ${path}: ${body.code} ${body.msg ?? ''}`);
    return body.data;
  }
  return {
    network,
    tickers: (market) => get(`/${market}/markets/tickers`),
    orderbook: (market, symbol) => get(`/${market}/markets/${encodeURIComponent(symbol)}/orderbook`),
  };
}
