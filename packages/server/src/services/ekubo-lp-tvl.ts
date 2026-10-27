/** Current value of Ekubo LP NFTs owned by deployed STRK20 shadow accounts.
 * The Ekubo indexer supplies current position liquidity and pool price;
 * Ekubo's SDK turns that into token amounts. Quotes value those amounts in USD.
 */
import { amount0Delta, amount1Delta, toSqrtRatio } from "@ekubo/sdk";
import { normalizeHex } from "@strk20/core";
import type { Db } from "../cache/db.js";
import { readState, type StreamState } from "./troves-shadow.js";
import { fetchStarkscanMarketSnapshot } from "./starkscan-market.js";

const EKUBO_API = "https://prod-api.ekubo.org";
const LLAMA_URL = "https://api.llama.fi/protocol/ekubo";
const LLAMA_COINS = "https://coins.llama.fi/prices/current/";
const COINGECKO = "https://api.coingecko.com/api/v3/simple/token_price/starknet";
const POSITIONS = normalizeHex("0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067");
const CHAIN_ID = normalizeHex("0x534e5f4d41494e");
const REFRESH_MS = 120_000;
const STALE_MS = 10 * 60_000;
const BATCH_SIZE = 20;

interface Position {
  id: string; owner: string|null; chain_id: string; positions_address: string;
  liquidity: string; bounds: {lower:number;upper:number};
  pool_key: {token0:string;token1:string};
  pool_state: {sqrt_ratio:string}|null;
}
type Values = {public:number; private:number; openPositions:number; accounts:number};
type Quote = {priceUsd:number;decimals:number};

async function json(fetchImpl:typeof fetch,url:string):Promise<any> {
  const response=await fetchImpl(url,{signal:AbortSignal.timeout(20_000)});
  if(!response.ok)throw Error(`Ekubo LP source HTTP ${response.status}`);
  return response.json();
}

function padded(address:string):string {
  return `0x${BigInt(address).toString(16).padStart(64,"0")}`;
}

function recentQuote(price:unknown,decimals:unknown,timestampMs:number,now:number):Quote|null {
  if(typeof price!=="number"||!Number.isFinite(price)||price<=0
      ||typeof decimals!=="number"||!Number.isInteger(decimals)||decimals<0||decimals>36
      ||!Number.isFinite(timestampMs)||timestampMs>now+60_000||now-timestampMs>STALE_MS)return null;
  return {priceUsd:price,decimals};
}

async function tokenQuotes(addresses:string[],market:Awaited<ReturnType<typeof fetchStarkscanMarketSnapshot>>|null,
    fetchImpl:typeof fetch,now:number):Promise<Map<string,Quote>> {
  const quotes=new Map<string,Quote>();
  for(const address of addresses){
    const item=market?.tokens.get(address);
    const quote=recentQuote(item?.priceUsd,item?.decimals,Date.parse(item?.updatedAtIso??""),now);
    if(quote)quotes.set(address,quote);
  }
  let missing=addresses.filter(address=>!quotes.has(address));
  let llamaCoins:Record<string,{price?:number;decimals?:number;timestamp?:number;confidence?:number}>={};
  if(missing.length){
    try{
      const body=await json(fetchImpl,`${LLAMA_COINS}${missing.map(address=>`starknet:${padded(address)}`).join(",")}`);
      if(body?.coins&&typeof body.coins==="object")llamaCoins=body.coins;
    }catch{/* CoinGecko remains available when the coin feed fails. */}
    for(const address of missing){
      const item=llamaCoins[`starknet:${padded(address)}`];
      if(item?.confidence!=null&&item.confidence<0.7)continue;
      const quote=recentQuote(item?.price,item?.decimals,(item?.timestamp??NaN)*1000,now);
      if(quote)quotes.set(address,quote);
    }
  }
  missing=addresses.filter(address=>!quotes.has(address));
  if(missing.length){
    const results=await Promise.allSettled(missing.map(async address=>{
      const uri=new URL(COINGECKO);
      uri.searchParams.set("contract_addresses",padded(address));
      uri.searchParams.set("vs_currencies","usd");
      uri.searchParams.set("include_last_updated_at","true");
      const body=await json(fetchImpl,uri.toString());
      const item=body?.[padded(address)];
      const decimals=market?.tokens.get(address)?.decimals??llamaCoins[`starknet:${padded(address)}`]?.decimals;
      return {address,quote:recentQuote(item?.usd,decimals,(item?.last_updated_at??NaN)*1000,now)};
    }));
    for(const result of results)if(result.status==="fulfilled"&&result.value.quote)
      quotes.set(result.value.address,result.value.quote);
  }
  if(addresses.some(address=>!quotes.has(address)))throw Error("Ekubo LP token quote unavailable or stale");
  return quotes;
}

export async function measureEkuboLpTvl(opts:{db:Db;chain:string;fetchImpl?:typeof fetch;now?:()=>number}):Promise<Values> {
  const now=opts.now??Date.now;
  const fetchImpl=opts.fetchImpl??fetch;
  const factory=readState<StreamState>(opts.db,`troves:factory:${opts.chain}`);
  if(factory?.coveredBlock==null||factory.targetBlock!==null||factory.completedAt==null
      ||now()-factory.completedAt>STALE_MS)throw Error("Shadow-account index incomplete or stale");
  const shadows=(opts.db.prepare("SELECT address FROM shadow_accounts WHERE chain=?").all(opts.chain) as {address:string}[])
    .map(row=>normalizeHex(row.address));
  if(!shadows.length)throw Error("Shadow-account history unavailable");
  const known=new Set(shadows);
  const positions=new Map<string,Position>();
  for(let i=0;i<shadows.length;i+=BATCH_SIZE){
    const query=new URLSearchParams({state:"opened",pageSize:"200"});
    for(const owner of shadows.slice(i,i+BATCH_SIZE))query.append("address",owner);
    for(let page=1;page<=100;page++){
      query.set("page",String(page));
      const body=await json(fetchImpl,`${EKUBO_API}/positions/batch?${query}`);
      if(!Array.isArray(body?.data)||!Number.isInteger(body?.pagination?.totalPages)
          ||body.pagination.totalPages<0||body.pagination.totalPages>100)throw Error("Invalid Ekubo position page");
      for(const candidate of body.data as Position[]){
        if(normalizeHex(candidate.chain_id)!==CHAIN_ID||normalizeHex(candidate.positions_address)!==POSITIONS)continue;
        if(!candidate.owner||!known.has(normalizeHex(candidate.owner)))throw Error("Ekubo position owner outside requested shadow accounts");
        const key=`${normalizeHex(candidate.positions_address)}:${normalizeHex(candidate.id)}`;
        if(positions.has(key))throw Error("Duplicate Ekubo LP position");
        positions.set(key,candidate);
      }
      if(page>=body.pagination.totalPages)break;
      if(page===100)throw Error("Ekubo positions exceeded page limit");
    }
  }
  const active=[...positions.values()].filter(p=>BigInt(p.liquidity)>0n);
  const addresses=[...new Set(active.flatMap(p=>[p.pool_key.token0,p.pool_key.token1]).map(normalizeHex))];
  const [market,llama]=await Promise.all([
    addresses.length?fetchStarkscanMarketSnapshot(addresses,{fetch:fetchImpl}).catch(()=>null):Promise.resolve(null),
    json(fetchImpl,LLAMA_URL),
  ]);
  const quotes=await tokenQuotes(addresses,market,fetchImpl,now());
  const latest=llama?.tvl?.at(-1);
  const total=llama?.currentChainTvls?.Starknet;
  if(!latest||!Number.isFinite(latest.date)||now()-latest.date*1000>48*60*60_000
      ||!Number.isFinite(total)||total<0)throw Error("Ekubo Starknet TVL unavailable or stale");
  let privateUsd=0;
  const owners=new Set<string>();
  for(const p of active){
    if(!Number.isSafeInteger(p.bounds?.lower)||!Number.isSafeInteger(p.bounds?.upper)
        ||p.bounds.lower>=p.bounds.upper||!p.pool_state?.sqrt_ratio)throw Error("Invalid Ekubo LP range or pool state");
    const sqrt=BigInt(p.pool_state.sqrt_ratio),lower=toSqrtRatio(p.bounds.lower,"starknet"),upper=toSqrtRatio(p.bounds.upper,"starknet");
    const liquidity=BigInt(p.liquidity);
    if(sqrt<=0n||liquidity<=0n)throw Error("Invalid Ekubo LP liquidity");
    const amount0=sqrt>=upper?0n:amount0Delta(sqrt>lower?sqrt:lower,upper,liquidity,false);
    const amount1=sqrt<=lower?0n:amount1Delta(lower,sqrt<upper?sqrt:upper,liquidity,false);
    for(const [address,raw] of [[p.pool_key.token0,amount0],[p.pool_key.token1,amount1]] as const){
      if(raw===0n)continue;
      const quote=quotes.get(normalizeHex(address));
      if(!quote)throw Error("Ekubo LP token quote unavailable or stale");
      privateUsd+=Number(raw)/10**quote.decimals*quote.priceUsd;
    }
    owners.add(normalizeHex(p.owner!));
  }
  if(!Number.isFinite(privateUsd)||privateUsd>total+0.01)throw Error("Ekubo shadow LP value exceeds Starknet TVL");
  return {public:Math.max(0,total-privateUsd),private:privateUsd,openPositions:active.length,accounts:owners.size};
}

export function createEkuboLpTvlService(opts:{db:Db;chain:string;fetchImpl?:typeof fetch;now?:()=>number}){
  const now=opts.now??Date.now;
  let current:{value:Values;updatedAt:number}|null=null;
  let failed=false,busy=false;
  async function refresh(){
    if(busy||opts.chain!=="SN_MAIN")return;
    busy=true;
    try{current={value:await measureEkuboLpTvl(opts),updatedAt:now()};failed=false;}
    catch(error){failed=true;console.error("ekubo-lp-tvl:",error);}
    finally{busy=false;}
  }
  function snapshot(){
    const live=current!=null&&now()-current.updatedAt<=STALE_MS;
    return {schemaVersion:1,protocol:"ekubo",scope:"starknet-ekubo-lp-nfts-by-strk20-shadow-owners",
      status:live?"live":current?"stale":failed?"unavailable":"indexing",unit:"usd",
      basis:"Ekubo Starknet LP TVL; private is current shadow-owned LP NFT value",
      public:live?current!.value.public:null,private:live?current!.value.private:null,
      openPositions:live?current!.value.openPositions:null,accounts:live?current!.value.accounts:null,
      asOf:current?new Date(current.updatedAt).toISOString():null};
  }
  function start(){if(opts.chain==="SN_MAIN"){void refresh();setInterval(()=>void refresh(),REFRESH_MS);}}
  return {refresh,snapshot,start};
}
