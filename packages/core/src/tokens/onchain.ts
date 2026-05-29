/**
 * On-chain ERC20 metadata helpers — for tokens not in any list (e.g. Vesu
 * vault tokens). Read symbol()/decimals() via a contract call and decode.
 *
 * Selectors are starknet_keccak of the entrypoint names (standard ERC20).
 */
export const ERC20_SYMBOL_SELECTOR =
  "0x216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4";
export const ERC20_DECIMALS_SELECTOR =
  "0x4c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9";

/**
 * Decode a `symbol()` return value. Modern Cairo returns a ByteArray
 * `[num_full_words, ...words(31 bytes), pending_word, pending_len]`; legacy
 * contracts return a single felt short-string. Handles both.
 */
export function decodeTokenSymbol(result: string[]): string {
  if (result.length === 0) return "";
  if (result.length === 1) return feltToAscii(BigInt(result[0]!));

  // ByteArray
  const numWords = Number(BigInt(result[0]!));
  const bytes: number[] = [];
  for (let i = 0; i < numWords; i++) {
    pushFeltBytes(bytes, BigInt(result[1 + i]!), 31);
  }
  const pending = BigInt(result[1 + numWords]!);
  const pendingLen = Number(BigInt(result[2 + numWords] ?? "0x0"));
  pushFeltBytes(bytes, pending, pendingLen);
  return String.fromCharCode(...bytes).replace(/[^\x20-\x7e]/g, "").trim();
}

export function decodeDecimals(result: string[]): number {
  return result.length > 0 ? Number(BigInt(result[0]!)) : 18;
}

function feltToAscii(felt: bigint): string {
  const bytes: number[] = [];
  let n = felt;
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return String.fromCharCode(...bytes).replace(/[^\x20-\x7e]/g, "").trim();
}

function pushFeltBytes(out: number[], felt: bigint, len: number): void {
  const bytes: number[] = [];
  let n = felt;
  for (let i = 0; i < len; i++) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  out.push(...bytes);
}
