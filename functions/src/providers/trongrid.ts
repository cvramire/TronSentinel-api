import {ApiError} from "../middleware/errors";
import {OnchainTransfer} from "../risk/onchain-features";

const DAY_MS = 86_400_000;
const TRONGRID_BASE_URL = "https://api.trongrid.io";
const CONTRACTS = [
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4",
] as const;
const PAGE_SIZE = 200;
const MAX_PAGES_PER_CONTRACT = 50;
const MIN_REQUEST_INTERVAL_MS = 100;
const MAX_RETRIES = 6;

type JsonObject = Record<string, any>;
let nextRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProviderSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
  if (waitMs) await sleep(waitMs);
}

async function requestJson(url: URL, apiKey: string): Promise<JsonObject> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await waitForProviderSlot();
      const response = await fetch(url, {
        headers: {accept: "application/json", "TRON-PRO-API-KEY": apiKey},
      });
      const text = await response.text();
      let body: JsonObject;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {raw: text.slice(0, 500)};
      }
      if (response.ok && body.success !== false) return body;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        if (!retryable) {
          throw new ApiError(
            502,
            "TRONGRID_REQUEST_REJECTED",
            `TronGrid rechazó la consulta con HTTP ${response.status}.`,
          );
        }
        throw new Error(`HTTP_${response.status}:${JSON.stringify(body).slice(0, 300)}`);
      }
      const suspended = Number(
        JSON.stringify(body).match(/suspended for (\d+) s/i)?.[1] || 0,
      ) * 1000;
      const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
      await sleep(Math.max(suspended, retryAfter, 500 * (2 ** attempt)));
    } catch (error: any) {
      if (error instanceof ApiError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === MAX_RETRIES) break;
      await sleep(500 * (2 ** attempt));
    }
  }
  throw new ApiError(
    502,
    "TRONGRID_UNAVAILABLE",
    `TronGrid no respondió después de los reintentos: ${lastError?.message || "error desconocido"}`,
  );
}

function normalizeTransfer(item: JsonObject, contract: string): OnchainTransfer | null {
  if (String(item.type || "").toLowerCase() !== "transfer") return null;
  const timestamp = Number(item.block_timestamp || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return {
    transactionId: String(item.transaction_id || ""),
    blockTimestamp: timestamp,
    from: String(item.from || ""),
    to: String(item.to || ""),
    valueRaw: String(item.value ?? ""),
    tokenAddress: String(item.token_info?.address || contract),
    tokenSymbol: String(item.token_info?.symbol || ""),
    tokenDecimals: Number(item.token_info?.decimals || 0),
    type: "Transfer",
  };
}

function transferKey(transfer: OnchainTransfer): string {
  return [
    transfer.transactionId, transfer.blockTimestamp, transfer.from, transfer.to,
    transfer.valueRaw, transfer.tokenAddress,
  ].join("|");
}

async function fetchContractHistory(input: {
  address: string;
  asOfMs: number;
  lookbackDays: number;
  contract: string;
  apiKey: string;
}): Promise<{transfers: OnchainTransfer[]; pages: number; truncated: boolean}> {
  const maxTimestamp = input.asOfMs - 1;
  const minTimestamp = maxTimestamp - input.lookbackDays * DAY_MS;
  const transfers: OnchainTransfer[] = [];
  let fingerprint = "";
  let pages = 0;
  let truncated = false;
  do {
    const url = new URL(
      `/v1/accounts/${encodeURIComponent(input.address)}/transactions/trc20`,
      TRONGRID_BASE_URL,
    );
    url.searchParams.set("only_confirmed", "true");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("order_by", "block_timestamp,asc");
    url.searchParams.set("min_timestamp", String(minTimestamp));
    url.searchParams.set("max_timestamp", String(maxTimestamp));
    url.searchParams.set("contract_address", input.contract);
    if (fingerprint) url.searchParams.set("fingerprint", fingerprint);
    const body = await requestJson(url, input.apiKey);
    pages += 1;
    for (const item of Array.isArray(body.data) ? body.data : []) {
      const transfer = normalizeTransfer(item, input.contract);
      if (transfer) transfers.push(transfer);
    }
    fingerprint = String(body.meta?.fingerprint || "");
    if (fingerprint && pages >= MAX_PAGES_PER_CONTRACT) {
      truncated = true;
      break;
    }
  } while (fingerprint);
  return {transfers, pages, truncated};
}

export async function fetchWalletHistory(input: {
  address: string;
  asOfMs: number;
  lookbackDays: number;
}): Promise<{
  transfers: OnchainTransfer[];
  pages: number;
  truncated: boolean;
  contracts: readonly string[];
  maxPagesPerContract: number;
  provider: "TRONGRID";
}> {
  const apiKey = String(process.env.APP_TRONGRID_API_KEY || "").trim();
  if (!apiKey) {
    throw new ApiError(
      503,
      "TRONGRID_API_KEY_NOT_CONFIGURED",
      "El secreto APP_TRONGRID_API_KEY no está configurado en la función.",
    );
  }
  const unique = new Map<string, OnchainTransfer>();
  let pages = 0;
  let truncated = false;
  for (const contract of CONTRACTS) {
    const result = await fetchContractHistory({...input, contract, apiKey});
    pages += result.pages;
    truncated ||= result.truncated;
    for (const transfer of result.transfers) unique.set(transferKey(transfer), transfer);
  }
  return {
    transfers: [...unique.values()],
    pages,
    truncated,
    contracts: CONTRACTS,
    maxPagesPerContract: MAX_PAGES_PER_CONTRACT,
    provider: "TRONGRID",
  };
}
