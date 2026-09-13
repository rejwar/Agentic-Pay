import { HermesClient } from "@pythnetwork/hermes-client";

const HERMES_URL = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network";
const client = new HermesClient(HERMES_URL);

const FEED_IDS: Record<string, string> = {
  "BTC": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "BTC/USD": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "SOL": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "SOL/USD": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};

interface CacheEntry {
  data: PricePayload;
  expiresAt: number;
}

export interface PricePayload {
  symbol: string;
  price: number;
  confidence: number;
  exponent: number;
  publishTime: number;
  source: string;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5_000;

export async function fetchPrice(symbol: string): Promise<PricePayload> {
  const now = Date.now();
  const cached = cache.get(symbol);
  if (cached && cached.expiresAt > now) return cached.data;

  const feedId = FEED_IDS[symbol.toUpperCase()];
  if (!feedId) throw new Error(`Unknown symbol: ${symbol}`);

  try {
    let p: { price: number; conf: number; expo: number; publishTime: number } | null = null;
    if (typeof (client as any).getLatestPriceUpdates === "function") {
      const res = await (client as any).getLatestPriceUpdates([feedId]);
      if (res?.parsed?.[0]?.price) {
        const item = res.parsed[0].price;
        p = {
          price: Number(item.price),
          conf: Number(item.conf),
          expo: Number(item.expo),
          publishTime: Number(item.publish_time),
        };
      }
    } else if (typeof (client as any).getPriceFeeds === "function") {
      const feeds = await (client as any).getPriceFeeds([feedId]);
      if (feeds?.length) {
        p = {
          price: Number(feeds[0].price.price),
          conf: Number(feeds[0].price.conf),
          expo: Number(feeds[0].price.expo),
          publishTime: Number(feeds[0].price.publishTime),
        };
      }
    }

    if (!p) throw new Error("No feed returned");
    const payload: PricePayload = {
      symbol: symbol.toUpperCase(),
      price: p.price,
      confidence: p.conf,
      exponent: p.expo,
      publishTime: p.publishTime,
      source: "pyth-hermes",
    };
    cache.set(symbol, { data: payload, expiresAt: now + CACHE_TTL_MS });
    return payload;
  } catch (err) {
    // Deterministic offline fallback so demos never break on network hiccups.
    let defaultPrice = 60_000_000_000;
    if (symbol.toUpperCase().startsWith("ETH")) defaultPrice = 3_400_000_000;
    if (symbol.toUpperCase().startsWith("SOL")) defaultPrice = 145_000_000;
    const fallback: PricePayload = {
      symbol: symbol.toUpperCase(),
      price: defaultPrice,
      confidence: 10_000_000,
      exponent: -8,
      publishTime: Math.floor(now / 1000),
      source: "pyth-hermes (offline fallback)",
    };
    console.warn(`[pyth] Falling back to offline price for ${symbol}:`, err);
    cache.set(symbol, { data: fallback, expiresAt: now + CACHE_TTL_MS });
    return fallback;
  }
}
