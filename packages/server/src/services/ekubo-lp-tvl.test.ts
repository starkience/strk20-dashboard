import {test} from "node:test";
import assert from "node:assert/strict";
import {toSqrtRatio} from "@ekubo/sdk";
import {openCache} from "../cache/db.js";
import {saveState,type StreamState} from "./troves-shadow.js";
import {measureEkuboLpTvl} from "./ekubo-lp-tvl.js";

test("Ekubo LP TVL includes current shadow-owned NFTs and excludes transferred-away positions",async()=>{
  const db=openCache(":memory:");
  try{
    const now=Date.now(),owner="0xabc",token0="0x111",token1="0x222";
    const state:StreamState={coveredBlock:100,fromBlock:0,targetBlock:null,cursor:null,completedAt:now};
    saveState(db,"troves:factory:SN_MAIN",state);
    db.prepare("INSERT INTO shadow_accounts(chain,address,deployed_block,tx_hash) VALUES(?,?,?,?)").run("SN_MAIN",owner,10,"0x1");
    const position=(id:string,liquidity:string,holder:string)=>({id,owner:holder,chain_id:"0x534e5f4d41494e",
      positions_address:"0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067",
      liquidity,bounds:{lower:-100,upper:100},pool_key:{token0,token1},
      pool_state:{sqrt_ratio:toSqrtRatio(0,"starknet").toString()}});
    const fetchImpl=async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes("/positions/batch"))return Response.json({pagination:{totalPages:1},data:[
        position("0x1","1000000000000000000",owner),position("0x2","0",owner),
      ]});
      if(url.endsWith("/protocol/ekubo"))return Response.json({tvl:[{date:Math.floor(now/1000),totalLiquidityUSD:1000}],currentChainTvls:{Starknet:1000}});
      if(url.endsWith("/tokens"))return Response.json({items:[token0,token1].map(tokenAddress=>({tokenAddress,decimals:18,
        priceUsd:1,updatedAtIso:new Date(now).toISOString()}))});
      return new Response(null,{status:404});
    };
    const result=await measureEkuboLpTvl({db,chain:"SN_MAIN",fetchImpl:fetchImpl as typeof fetch,now:()=>now});
    assert.equal(result.openPositions,1);
    assert.equal(result.accounts,1);
    assert.ok(result.private>0&&result.private<1000);
    assert.equal(result.public+result.private,1000);
  }finally{db.close();}
});

test("Ekubo LP TVL follows every page of a shadow owner's open positions",async()=>{
  const db=openCache(":memory:");
  try{
    const now=Date.now(),owner="0xabc";
    saveState(db,"troves:factory:SN_MAIN",{coveredBlock:100,fromBlock:0,targetBlock:null,cursor:null,completedAt:now});
    db.prepare("INSERT INTO shadow_accounts(chain,address,deployed_block,tx_hash) VALUES(?,?,?,?)").run("SN_MAIN",owner,10,"0x1");
    const position=(id:string)=>({id,owner,chain_id:"0x534e5f4d41494e",
      positions_address:"0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067",
      liquidity:"1000000000000000000",bounds:{lower:-100,upper:100},
      pool_key:{token0:"0x111",token1:"0x222"},pool_state:{sqrt_ratio:toSqrtRatio(0,"starknet").toString()}});
    const requested:number[]=[];
    const fetchImpl=async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes("/positions/batch")){
        const page=Number(new URL(url).searchParams.get("page"));requested.push(page);
        return Response.json({pagination:{totalPages:2},data:[position(`0x${page}`)]});
      }
      if(url.endsWith("/protocol/ekubo"))return Response.json({tvl:[{date:Math.floor(now/1000)}],currentChainTvls:{Starknet:1000}});
      if(url.endsWith("/tokens"))return Response.json({items:["0x111","0x222"].map(tokenAddress=>({tokenAddress,decimals:18,
        priceUsd:1,updatedAtIso:new Date(now).toISOString()}))});
      return new Response(null,{status:404});
    };
    const result=await measureEkuboLpTvl({db,chain:"SN_MAIN",fetchImpl:fetchImpl as typeof fetch,now:()=>now});
    assert.deepEqual(requested,[1,2]);
    assert.equal(result.openPositions,2);
    assert.ok(result.private>0);
  }finally{db.close();}
});

test("Ekubo LP TVL recovers from a delayed market quote with a fresh address-specific quote",async()=>{
  const db=openCache(":memory:");
  try{
    const now=Date.now(),owner="0xabc",token0="0x111",token1="0x222";
    const padded=`0x${BigInt(token0).toString(16).padStart(64,"0")}`;
    saveState(db,"troves:factory:SN_MAIN",{coveredBlock:100,fromBlock:0,targetBlock:null,cursor:null,completedAt:now});
    db.prepare("INSERT INTO shadow_accounts(chain,address,deployed_block,tx_hash) VALUES(?,?,?,?)").run("SN_MAIN",owner,10,"0x1");
    const seen:string[]=[];
    const fetchImpl=async(input:RequestInfo|URL)=>{
      const url=String(input);seen.push(url);
      if(url.includes("/positions/batch"))return Response.json({pagination:{totalPages:1},data:[{
        id:"0x1",owner,chain_id:"0x534e5f4d41494e",
        positions_address:"0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067",
        liquidity:"1000000000000000000",bounds:{lower:-100,upper:100},pool_key:{token0,token1},
        pool_state:{sqrt_ratio:toSqrtRatio(0,"starknet").toString()},
      }]});
      if(url.endsWith("/protocol/ekubo"))return Response.json({tvl:[{date:Math.floor(now/1000)}],currentChainTvls:{Starknet:1000}});
      if(url.endsWith("/tokens"))return Response.json({items:[token0,token1].map(tokenAddress=>({tokenAddress,
        decimals:18,priceUsd:1,updatedAtIso:new Date(tokenAddress===token0?now-11*60_000:now).toISOString()}))});
      if(url.includes("coins.llama.fi"))return Response.json({coins:{[`starknet:${padded}`]:{
        price:1,decimals:18,timestamp:Math.floor((now-60*60_000)/1000),confidence:0.99}}});
      if(url.includes("api.coingecko.com"))return Response.json({[padded]:{
        usd:1,last_updated_at:Math.floor(now/1000)}});
      return new Response(null,{status:404});
    };
    const result=await measureEkuboLpTvl({db,chain:"SN_MAIN",fetchImpl:fetchImpl as typeof fetch,now:()=>now});
    assert.ok(result.private>0);
    assert.ok(seen.some(url=>url.includes("coins.llama.fi")));
    assert.ok(seen.some(url=>url.includes("api.coingecko.com")));
  }finally{db.close();}
});
