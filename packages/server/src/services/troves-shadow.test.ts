import {test} from "node:test";
import assert from "node:assert/strict";
import {type RawContractEvent,selectorOf} from "@strk20/core";
import {openCache} from "../cache/db.js";
import {decodeVaultActivity,parseCatalogue,recordShadowAccount,recordVaultActivity,readState,saveState,
  syncShadowStream,trovesShadowActivity,vaultStreamKey,SHADOW_ANONYMIZER,SHADOW_DEPLOYED,type StreamState} from "./troves-shadow.js";
const CHAIN="SN_MAIN", VAULT="0x123", ACCOUNT="0xabc";
const catalogue={vaults:[{address:VAULT,id:"test-vault",name:"Test vault"}],excludedStrategyIds:[]};
function event(p:Partial<RawContractEvent>={}):RawContractEvent {
  return {address:VAULT,blockNumber:11,txIndex:0,logIndex:0,txHash:"0x111",timestampIso:"2026-10-20T12:00:00Z",
    topic0:selectorOf("Deposit"),topic1:ACCOUNT,topic2:ACCOUNT,topic3:null,data:[],eventName:"Deposit",
    decodedFields:[{label:"sender",status:"decoded",addressValue:ACCOUNT},{label:"owner",status:"decoded",addressValue:ACCOUNT}],...p};
}
function ready(db:ReturnType<typeof openCache>,head=20) {
  saveState(db,`troves:catalog:${CHAIN}`,catalogue);
  const state:StreamState={coveredBlock:head,fromBlock:0,targetBlock:null,cursor:null,completedAt:Date.now()};
  saveState(db,`troves:factory:${CHAIN}`,state);saveState(db,vaultStreamKey(CHAIN,catalogue.vaults),state);
}
function deploy(db:ReturnType<typeof openCache>,blockNumber=10) {
  recordShadowAccount(db,CHAIN,event({address:SHADOW_ANONYMIZER,topic0:SHADOW_DEPLOYED,topic2:ACCOUNT,blockNumber}));
}
test("counts only deployed shadow owners in curated vaults; overlap and batches do not inflate transactions",()=>{
  const db=openCache(":memory:");try {
    ready(db);deploy(db);
    const dep=event();recordVaultActivity(db,CHAIN,dep);recordVaultActivity(db,CHAIN,dep);
    recordVaultActivity(db,CHAIN,event({logIndex:1,eventName:"Withdraw",decodedFields:[{label:"owner",status:"decoded",addressValue:ACCOUNT}]}));
    // A shadow sender depositing to a public owner is not a shadow-owned position.
    recordVaultActivity(db,CHAIN,event({logIndex:2,decodedFields:[{label:"sender",status:"decoded",addressValue:ACCOUNT},{label:"owner",status:"decoded",addressValue:"0xdef"}]}));
    recordVaultActivity(db,CHAIN,event({logIndex:3,blockNumber:9}));
    recordVaultActivity(db,CHAIN,event({logIndex:4,address:"0x999"}));
    recordVaultActivity(db,CHAIN,event({logIndex:5,blockNumber:21}));
    const result=trovesShadowActivity(db,CHAIN);
    assert.equal(result.status,"live");assert.equal(result.transactionCount,1);assert.equal(result.activeShadowAccounts,1);
    assert.deepEqual(result.eventCounts,{deposit:1,withdraw:1,withdraw_request:0,withdraw_claim:0});
  }finally{db.close()}
});
test("withdraw requests and claims are separate events and do not masquerade as dollar volume",()=>{
  const db=openCache(":memory:");try {
    ready(db);deploy(db);
    recordVaultActivity(db,CHAIN,event({eventName:"RedeemRequested",decodedFields:[{label:"owner",status:"decoded",addressValue:ACCOUNT}]}));
    recordVaultActivity(db,CHAIN,event({txHash:"0x222",txIndex:1,eventName:"RedeemClaimed",decodedFields:[{label:"receiver",status:"decoded",addressValue:ACCOUNT}]}));
    const result=trovesShadowActivity(db,CHAIN);assert.equal(result.transactionCount,2);
    assert.equal(result.eventCounts?.withdraw_request,1);assert.equal(result.eventCounts?.withdraw_claim,1);
    assert.equal("tvlUsd" in result,false);
  }finally{db.close()}
});
test("unknown or failed ABI decoding is partial coverage, not a measured zero",()=>{
  const db=openCache(":memory:");try {
    assert.equal(trovesShadowActivity(db,CHAIN).transactionCount,null);
    ready(db);recordVaultActivity(db,CHAIN,event({decodedFields:[]}));
    assert.equal(trovesShadowActivity(db,CHAIN).status,"partial");
    assert.equal(decodeVaultActivity(event({decodedFields:[{label:"owner",status:"failed",addressValue:ACCOUNT}]})).kind,"undecoded");
  }finally{db.close()}
});
test("a completed empty history is zero; old successful coverage becomes stale",()=>{
  const db=openCache(":memory:");try {
    ready(db);assert.equal(trovesShadowActivity(db,CHAIN).transactionCount,0);
    assert.equal(trovesShadowActivity(db,CHAIN,Date.now()+11*60_000).status,"stale");
  }finally{db.close()}
});
test("fixed finalized range resumes across empty pages; cursor completion and dedup are durable",async()=>{
  const db=openCache(":memory:");try {
    const calls:{fromBlock:number;toBlock:number;cursor?:string|null}[]=[];
    let n=0;
    const client={globalEvents:async(opts:{fromBlock:number;toBlock:number;cursor?:string|null})=>{
      calls.push(opts);return n++===0?{items:[],nextCursor:"15:0:0"}:{items:[event()],nextCursor:null};
    }};
    const base={db,client,key:"test",addresses:[VAULT],topics:[selectorOf("Deposit")],fromBlock:10,consume:(e:RawContractEvent)=>recordVaultActivity(db,CHAIN,e),maxPages:1};
    const a=await syncShadowStream({...base,head:20});assert.equal(a.coveredBlock,null);assert.equal(a.cursor,"15:0:0");
    const b=await syncShadowStream({...base,head:100});assert.equal(b.coveredBlock,20);assert.equal(calls[1]?.toBlock,20);
    assert.equal(calls[1]?.cursor,"15:0:0");
    await syncShadowStream({...base,head:30,client:{globalEvents:async opts=>{assert.equal(opts.fromBlock,20);return{items:[],nextCursor:null}}}});
    assert.equal(readState<StreamState>(db,"test")?.coveredBlock,30);
  }finally{db.close()}
});
test("rejects upstream out-of-scope events without advancing the checkpoint",async()=>{
  const db=openCache(":memory:");try {
    await assert.rejects(syncShadowStream({db,client:{globalEvents:async()=>({items:[event({blockNumber:50})],nextCursor:null})},
      key:"bad",addresses:[VAULT],topics:[],fromBlock:10,head:20,consume:()=>assert.fail("must validate first")}),/outside requested scope/);
    assert.equal(readState(db,"bad"),null);
  }finally{db.close()}
});
test("catalogue requires a successful official response and identifies strategies without vault contracts",()=>{
  assert.throws(()=>parseCatalogue({status:false,strategies:[]}),/unavailable/);
  const result=parseCatalogue({status:true,strategies:[{id:"vault",name:"Vault",contract:[{name:"Vault",address:"0x0123"}]},{id:"no-vault",name:"Staking",contract:[]}]});
  assert.equal(result.vaults[0]?.address,VAULT);assert.deepEqual(result.excludedStrategyIds,["no-vault"]);
});

test("legacy nested ERC4626 and asynchronous redemption layouts decode without guessing unknown shapes",()=>{
  const base=event(); delete base.decodedFields;
  const nested={...base,eventName:"ERC4626Event",topic0:selectorOf("ERC4626Event"),keys:[selectorOf("ERC4626Event"),selectorOf("Deposit"),ACCOUNT,ACCOUNT],data:["0x1","0x0","0x1","0x0"]};
  assert.deepEqual(decodeVaultActivity(nested),{kind:"deposit",account:ACCOUNT});
  assert.deepEqual(decodeVaultActivity({...nested,data:[]}),{kind:"undecoded",account:null});
  const claim={...base,topic0:selectorOf("RedeemClaimed"),keys:[selectorOf("RedeemClaimed")],data:[ACCOUNT,...Array(8).fill("0x0")]};
  assert.deepEqual(decodeVaultActivity(claim),{kind:"withdraw_claim",account:ACCOUNT});
});

test("Starkscan client sends the exact finalized block and repeated address/topic filters",async()=>{
  const {StarkscanClient}=await import("@strk20/core");let seen="";
  const client=new StarkscanClient({baseUrl:"https://api.test",apiKey:"test",fetch:async(input)=>{
    seen=String(input);return new Response(JSON.stringify({items:[],nextCursor:null}),{status:200,headers:{"Content-Type":"application/json"}});
  }});
  await client.globalEvents({addresses:[VAULT,"0x456"],topics:["0x1","0x2"],fromBlock:10,toBlock:20,cursor:"15:2:3",limit:100});
  const url=new URL(seen);assert.deepEqual(url.searchParams.getAll("address"),[VAULT,"0x456"]);
  assert.deepEqual(url.searchParams.getAll("topic0"),["0x1","0x2"]);
  assert.equal(url.searchParams.get("from_block"),"10");assert.equal(url.searchParams.get("to_block"),"20");
  assert.equal(url.searchParams.get("cursor"),"15:2:3");
});
