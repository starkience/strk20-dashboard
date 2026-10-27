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
