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
  /** Max retries on 429 / 5xx. */
  maxRetries?: number;
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
    this.fetchImpl = opts.fetch ?? fetch;
  }

  getRateLimitState(): RateLimitState {
    return { ...this.lastRateLimit };
  }

  async status(): Promise<StatusResponse> {
    return this.get<StatusResponse>(`/v1/${this.chain}/status`);
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

      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          "X-Starkscan-Api-Key": this.apiKey,
          Accept: "application/json",
        },
      });
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
