/**
 * Starkscan Explorer API client.
 *
 * Reads X-Ratelimit-* headers and backs off as remaining requests get scarce.
 * Retries on 429 (using Retry-After when present) and on transient 5xx.
 * See: reference_starkscan_api memory and /Users/starkience/Downloads/api-1.json
 */

export interface StarkscanClientOptions {
  baseUrl: string;
  apiKey: string;
  chain?: string;
  /** Soft cap below which we slow down. Defaults to 10% of the observed limit. */
  rateLimitFloor?: number;
  /** Max retries on 429 / 5xx / network error. */
  maxRetries?: number;
  /**
   * Per-request timeout (ms). A hung connection is aborted after this and
   * retried like a transient error, so a stalled upstream can't silently
   * wedge the sync loop forever. Defaults to 15s.
   */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  policy: string | null;
  observedAt: number;
}

export interface StatusResponse {
  chainId: string;
  headBlockNumber: number;
  headBlockHash: string;
  finalizedBlockNumber: number;
  latestIndexedBlockNumber: number;
  earliestIndexedBlockNumber: number;
  indexedBlockSpan: number;
  lagBlocks: number;
  l1SettlementLatencySeconds: number | null;
}

export interface RawContractEvent {
  blockNumber: number;
  timestampIso: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  address: string;
  topic0: string;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data: string[];
}

export interface ContractEventsResponse {
  items: RawContractEvent[];
  nextCursor: string | null;
}

export interface ContractReadResponse {
  chainId: string;
  contractAddress: string;
  selector: string;
  blockTag: string;
  result: string[];
}

export interface ContractEntrypoint {
  selector: string;
  name: string | null;
  stateMutability: string | null;
}

export interface ContractEntrypointsResponse {
  chainId: string;
  contractAddress: string;
  external: ContractEntrypoint[];
  constructor: ContractEntrypoint[];
  l1Handler: ContractEntrypoint[];
}

/**
 * Supported accounting payload from Starkscan's Privacy Pool API.
 *
 * Raw amounts and address-keyed metadata are the integration contract. The
 * deprecated valuation fields returned by Starkscan are deliberately omitted:
 * callers must price these amounts independently.
 */
export interface PrivacyPoolTvlToken {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

export interface PrivacyPoolTvlAsset {
  token: PrivacyPoolTvlToken;
  status: "complete" | "degraded";
  reasonCode:
    | "finalized_public_flow_ledger"
    | "amount_decode_incomplete"
    | "negative_protected_amount";
  poolContractCount: number;
  depositEventCount: number;
  withdrawalEventCount: number;
  depositAmountRaw: string;
  withdrawalAmountRaw: string;
  protectedAmountRaw: string;
  protectedAmount: string | null;
  missingAmountEventCount: number;
}

export interface PrivacyPoolTvlResponse {
  schemaVersion: "1";
  chainId: string;
  scope: "strk20_privacy_pool";
  accountingMethod: "finalized_public_flow_ledger_v1";
  status: "complete" | "degraded" | "unavailable";
  asOf: {
    blockNumber: number | null;
    blockHash: string | null;
    blockTimestamp: string | null;
    materializedAt: string | null;
  };
  coverage: {
    status: "complete" | "partial" | "unavailable";
    reasonCode: string;
    finalizedOnly: true;
    finalityBasis: "starkscan_indexed_finalized_tier";
    latestL1AcceptedBlockNumber: number | null;
    asOfL1Accepted: boolean | null;
    fromBlockNumber: number | null;
    throughBlockNumber: number | null;
    latestEventBlockNumber: number | null;
    latestEventCursor: string | null;
    poolContractCount: number;
    tokenCount: number;
    missingAmountEventCount: number;
    decodedMaterializationFresh: boolean | null;
    decodedEventLagBlocks: number | null;
  };
  assets: PrivacyPoolTvlAsset[];
  caveat: string;
}

export class StarkscanError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "StarkscanError";
  }
}

const DEFAULT_CHAIN = "SN_MAIN";

export class StarkscanClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly chain: string;
  private readonly rateLimitFloor: number;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastRateLimit: RateLimitState = {
    limit: null,
    remaining: null,
    policy: null,
    observedAt: 0,
  };

  constructor(opts: StarkscanClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.chain = opts.chain ?? DEFAULT_CHAIN;
    this.rateLimitFloor = opts.rateLimitFloor ?? 12; // ~10% of the 120/min light tier
    this.maxRetries = opts.maxRetries ?? 4;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  getRateLimitState(): RateLimitState {
    return { ...this.lastRateLimit };
  }

  async status(): Promise<StatusResponse> {
    return this.get<StatusResponse>(`/v1/${this.chain}/status`);
  }

  /** Finalized deposits-minus-withdrawals snapshot for the STRK20 pool. */
  async privacyPoolTvl(): Promise<PrivacyPoolTvlResponse> {
    return this.get<PrivacyPoolTvlResponse>(
      `/v1/${this.chain}/privacy-pool/tvl`
    );
  }

  async contractEntrypoints(address: string): Promise<ContractEntrypointsResponse> {
    return this.get<ContractEntrypointsResponse>(
      `/v1/${this.chain}/contract/${address}/entrypoints`
    );
  }

  async contractEvents(
    address: string,
    opts: { limit?: number; cursor?: string | null } = {}
  ): Promise<ContractEventsResponse> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return this.get<ContractEventsResponse>(
      `/v1/${this.chain}/contract/${address}/events${qs ? `?${qs}` : ""}`
    );
  }

  /**
   * Async iterator over all events emitted by a contract.
   * Stops when nextCursor is null. Caller controls pageSize.
   */
  async *iterateContractEvents(
    address: string,
    pageSize = 100
  ): AsyncGenerator<RawContractEvent, void, void> {
    let cursor: string | null = null;
    do {
      const page: ContractEventsResponse = await this.contractEvents(address, {
        limit: pageSize,
        cursor,
      });
      for (const ev of page.items) yield ev;
      cursor = page.nextCursor;
    } while (cursor);
  }

  async tokenMeta(tokenAddress: string): Promise<{
    tokenAddress: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    standard: string | null;
  }> {
    return this.get(`/v1/${this.chain}/token/${tokenAddress}`);
  }

  async tokenBalanceOf(
    tokenAddress: string,
    ownerAddress: string,
    blockTag = "latest"
  ): Promise<{ balanceRaw: string; ownerAddress: string; tokenAddress: string }> {
    const params = new URLSearchParams();
    if (blockTag) params.set("block_tag", blockTag);
    const qs = params.toString();
    return this.get<{
      balanceRaw: string;
      ownerAddress: string;
      tokenAddress: string;
    }>(
      `/v1/${this.chain}/token/${tokenAddress}/balance-of/${ownerAddress}${
        qs ? `?${qs}` : ""
      }`
    );
  }

  async contractRead(
    address: string,
    selector: string,
    opts: { calldata?: string[]; blockTag?: string } = {}
  ): Promise<ContractReadResponse> {
    const params = new URLSearchParams();
    params.set("selector", selector);
    for (const v of opts.calldata ?? []) params.append("calldata", v);
    if (opts.blockTag) params.set("block_tag", opts.blockTag);
    return this.get<ContractReadResponse>(
      `/v1/${this.chain}/contract/${address}/read?${params.toString()}`
    );
  }

  private async get<T>(path: string): Promise<T> {
    let attempt = 0;
    while (true) {
      // Soft slow-down when remaining is below the floor.
      await this.maybeSlowDown();

      // Abort a hung request after requestTimeoutMs so a stalled connection
      // can't block forever (the failure mode that froze the live feed).
      let res: Response;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.requestTimeoutMs);
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "GET",
          headers: {
            "X-Starkscan-Api-Key": this.apiKey,
            Accept: "application/json",
          },
          signal: ctrl.signal,
        });
      } catch (err) {
        // No response at all — timeout abort or network failure. Treat as
        // transient: retry with backoff, then surface as a StarkscanError
        // (status 0) so the caller sees a real error instead of a hang.
        if (attempt < this.maxRetries) {
          await sleep(Math.min(8_000, 250 * 2 ** attempt));
          attempt += 1;
          continue;
        }
        const isAbort = (err as Error)?.name === "AbortError";
        const msg = isAbort
          ? `Starkscan request timed out after ${this.requestTimeoutMs}ms: ${path}`
          : `Starkscan request failed: ${(err as Error)?.message ?? String(err)}`;
        throw new StarkscanError(msg, 0, msg);
      } finally {
        clearTimeout(timer);
      }
      this.recordRateLimit(res.headers);

      if (res.ok) {
        return (await res.json()) as T;
      }

      const body = await res.text();
      const reqId = res.headers.get("X-Request-Id") ?? undefined;

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        const backoff = retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8_000, 250 * 2 ** attempt);
        await sleep(backoff);
        attempt += 1;
        continue;
      }

      throw new StarkscanError(
        `Starkscan ${res.status}: ${body.slice(0, 240)}`,
        res.status,
        body,
        reqId
      );
    }
  }

  private recordRateLimit(headers: Headers) {
    const limit = headers.get("X-Ratelimit-Limit");
    const remaining = headers.get("X-Ratelimit-Remaining");
    const policy = headers.get("X-Ratelimit-Policy");
    this.lastRateLimit = {
      limit: limit ? Number(limit) : null,
      remaining: remaining ? Number(remaining) : null,
      policy,
      observedAt: Date.now(),
    };
  }

  private async maybeSlowDown() {
    const { remaining } = this.lastRateLimit;
    if (remaining == null) return;
    if (remaining > this.rateLimitFloor) return;
    // Remaining is scarce — sleep until the next minute boundary to let the bucket refill.
    // The policy `light;w=60` resets each 60s window.
    const sleepMs = remaining <= 1 ? 5_000 : 1_500;
    await sleep(sleepMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
