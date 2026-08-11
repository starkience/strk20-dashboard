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

/**
 * A protocol fee leg Starkscan attached to a withdrawal, resolved against the
 * pool's FeeCollectorSet / FeeAmountSet history (which config was in force at
 * that block). Amounts are raw integer strings.
 */
export interface PrivacyPoolFee {
  tokenAddress: string;
  amountRaw: string;
  collectorAddress: string;
  transferLogIndex: number | null;
  transferIndex: number | null;
  feeCollectorConfigBlockNumber: number | null;
  feeAmountConfigBlockNumber: number | null;
}

/**
 * The publicly observable part of a privacy-pool event, decoded by Starkscan.
 * `visibility` says how much the event reveals by design: "public",
 * "partial" (an edge crossing — one side is in the clear), or
 * "hidden_by_design" (note-only; amounts and parties are private).
 */
export interface PrivacyPoolPublicFields {
  visibility: "public" | "partial" | "hidden_by_design" | string;
  actorAddress: string | null;
  toAddress: string | null;
  token: {
    address: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
  } | null;
  amountRaw: string | null;
  noteId: string | null;
  nullifier: string | null;
  auditorPublicKey: string | null;
}

/**
 * A privacy-pool event as served by Starkscan's dedicated route: the same raw
 * log we used to decode ourselves, plus Starkscan's own decoding of it.
 */
export interface PrivacyPoolEvent extends RawContractEvent {
  /** snake_case short name, e.g. "deposit" / "viewing_key_set". */
  eventName: string | null;
  publicFields: PrivacyPoolPublicFields | null;
  privacyFees: PrivacyPoolFee[] | null;
}

export interface PrivacyPoolEventsResponse {
  items: PrivacyPoolEvent[];
  nextCursor: string | null;
}

/** Wire shape of a /privacy-pool/events item (keys[] rather than topicN). */
interface PrivacyPoolEventWire {
  blockNumber: number;
  timestampIso: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  contractAddress: string;
  topic0: string;
  keys?: string[];
  data?: string[];
  eventName?: string | null;
  publicFields?: PrivacyPoolPublicFields | null;
  privacyFees?: PrivacyPoolFee[] | null;
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
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastRateLimit: RateLimitState = {
    limit: null,
    remaining: null,
    policy: null,
    observedAt: 0,
  };
  /**
   * Rate-limit state per policy bucket, and which bucket a given route was
   * last billed to.
   *
   * Starkscan meters by load class, not per key: the privacy-pool routes bill
   * to `heavy;w=60` (240/min) while contract/token reads bill to `light;w=60`
   * (600/min). Tracking a single "remaining" mixes them, so a light response
   * showing 500 left would wave through a heavy request with 2 left. Keyed by
   * policy, the throttle compares each route against its own bucket.
   */
  private readonly rateLimitByPolicy = new Map<string, RateLimitState>();
  private readonly policyByRoute = new Map<string, string>();

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
   * Privacy-pool events — the same logs as contractEvents, but from
   * Starkscan's protocol-aware route, which returns them already decoded
   * (eventName, publicFields, privacyFees) instead of raw felts we have to
   * position-decode ourselves.
   *
   * Chain-scoped, not contract-scoped: the route has no contract filter, so
   * callers that care about one pool must filter on `address` themselves.
   * Paginates newest→older by cursor, like contractEvents; the API clamps
   * limit to 100.
   */
  async privacyPoolEvents(
    opts: { limit?: number; cursor?: string | null; event?: string } = {}
  ): Promise<PrivacyPoolEventsResponse> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.event) params.set("event", opts.event);
    const qs = params.toString();
    const body = await this.get<{
      items?: PrivacyPoolEventWire[];
      nextCursor?: string | null;
    }>(`/v1/${this.chain}/privacy-pool/events${qs ? `?${qs}` : ""}`);
    return {
      items: (body.items ?? []).map(toPrivacyPoolEvent),
      nextCursor: body.nextCursor ?? null,
    };
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
    const route = routeKey(path);
    while (true) {
      // Soft slow-down when this route's own bucket is running low.
      await this.maybeSlowDown(route);

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
      this.recordRateLimit(res.headers, route);

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

  private recordRateLimit(headers: Headers, route: string) {
    const limit = headers.get("X-Ratelimit-Limit");
    const remaining = headers.get("X-Ratelimit-Remaining");
    const policy = headers.get("X-Ratelimit-Policy");
    const state: RateLimitState = {
      limit: limit ? Number(limit) : null,
      remaining: remaining ? Number(remaining) : null,
      policy,
      observedAt: Date.now(),
    };
    this.lastRateLimit = state;
    if (policy) {
      this.rateLimitByPolicy.set(policy, state);
      this.policyByRoute.set(route, policy);
    }
  }

  private async maybeSlowDown(route: string) {
    // Which bucket this route bills to is only knowable from a past response,
    // so a route we've never called gets no throttle — the 429 retry path
    // covers that first request.
    const policy = this.policyByRoute.get(route);
    if (!policy) return;
    const remaining = this.rateLimitByPolicy.get(policy)?.remaining;
    if (remaining == null) return;
    if (remaining > this.rateLimitFloor) return;
    // Remaining is scarce — sleep to let the bucket refill. Both policies
    // (`light;w=60`, `heavy;w=60`) reset each 60s window.
    const sleepMs = remaining <= 1 ? 5_000 : 1_500;
    await sleep(sleepMs);
  }
}

/**
 * Collapse a path to the route it belongs to, so per-route rate-limit state
 * isn't fragmented across every address/hash/cursor we ask about. Hex
 * segments and query strings are the varying parts.
 */
function routeKey(path: string): string {
  return path
    .split("?")[0]!
    .split("/")
    .map((seg) => (/^0x[0-9a-f]+$/i.test(seg) ? ":id" : seg))
    .join("/");
}

/**
 * Wire → RawContractEvent, so a privacy-pool event drops into everything that
 * already consumes contract events. The route ships `keys[]` (topic0 first)
 * where the generic route ships topic0..topic3, so the tail keys are spread
 * back out; extra keys beyond topic3 stay in `keys` and are not lost, because
 * the pool's events never declare more than three.
 */
function toPrivacyPoolEvent(e: PrivacyPoolEventWire): PrivacyPoolEvent {
  const keys = e.keys ?? [];
  return {
    blockNumber: e.blockNumber,
    timestampIso: e.timestampIso,
    txHash: e.txHash,
    txIndex: e.txIndex,
    logIndex: e.logIndex,
    address: e.contractAddress,
    topic0: e.topic0 ?? keys[0] ?? "",
    topic1: keys[1] ?? null,
    topic2: keys[2] ?? null,
    topic3: keys[3] ?? null,
    data: e.data ?? [],
    eventName: e.eventName ?? null,
    publicFields: e.publicFields ?? null,
    privacyFees: e.privacyFees ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
