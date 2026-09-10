import { getIngestState, setIngestState } from "../db.js";

const KEY_API_KEY = "polymarket.apiKey";
const KEY_API_SECRET = "polymarket.apiSecret";
const KEY_API_PASSPHRASE = "polymarket.apiPassphrase";

export type PolymarketCredentials = {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
};

function fromEnv(): PolymarketCredentials {
  return {
    apiKey: process.env.POLYMARKET_API_KEY?.trim() ?? "",
    apiSecret: process.env.POLYMARKET_API_SECRET?.trim() ?? "",
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE?.trim() ?? "",
  };
}

/** Prefer DB-stored keys (from settings UI); fall back to env. */
export function getPolymarketCredentials(): PolymarketCredentials {
  const env = fromEnv();
  return {
    apiKey: getIngestState(KEY_API_KEY)?.trim() || env.apiKey,
    apiSecret: getIngestState(KEY_API_SECRET)?.trim() || env.apiSecret,
    apiPassphrase:
      getIngestState(KEY_API_PASSPHRASE)?.trim() || env.apiPassphrase,
  };
}

export function setPolymarketCredentials(
  next: Partial<PolymarketCredentials>,
): PolymarketCredentials {
  if (next.apiKey != null) setIngestState(KEY_API_KEY, next.apiKey.trim());
  if (next.apiSecret != null)
    setIngestState(KEY_API_SECRET, next.apiSecret.trim());
  if (next.apiPassphrase != null)
    setIngestState(KEY_API_PASSPHRASE, next.apiPassphrase.trim());
  return getPolymarketCredentials();
}

export function credentialsStatus(): {
  configured: boolean;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  hasApiPassphrase: boolean;
  source: "database" | "env" | "none";
} {
  const dbKey = Boolean(getIngestState(KEY_API_KEY)?.trim());
  const env = fromEnv();
  const creds = getPolymarketCredentials();
  const configured = Boolean(creds.apiKey);
  let source: "database" | "env" | "none" = "none";
  if (dbKey) source = "database";
  else if (env.apiKey) source = "env";
  return {
    configured,
    hasApiKey: Boolean(creds.apiKey),
    hasApiSecret: Boolean(creds.apiSecret),
    hasApiPassphrase: Boolean(creds.apiPassphrase),
    source,
  };
}

/** Optional auth headers for Polymarket HTTP calls when credentials exist. */
export function polymarketAuthHeaders(): Record<string, string> {
  const { apiKey, apiSecret, apiPassphrase } = getPolymarketCredentials();
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["POLY_API_KEY"] = apiKey;
    headers["X-API-KEY"] = apiKey;
  }
  if (apiPassphrase) headers["POLY_PASSPHRASE"] = apiPassphrase;
  if (apiSecret) headers["POLY_API_SECRET"] = apiSecret;
  return headers;
}
