'use strict';
// Low-priority asynchronous cache. Never awaited by signal scanning.
class MeasurementCache {
  constructor(){this.entries=new Map();this.wanted=new Map();this.busy=false;this.cursor=0;}
  watch(symbols,testnet){this.wanted=new Map(symbols.slice(0,120).map(s=>[s,testnet]));}
  get(symbol,testnet,at){const x=this.entries.get(symbol);return x&&x.testnet===testnet&&x.receivedAt<=at?x:null;}
  async advance(get=require('./bybit').researchGetStamped,onError=()=>{},now=Date.now()) {
    if(this.busy||!this.wanted.size)return;this.busy=true;
    try {
      const all=[...this.wanted];
      for(let i=0;i<4;i++) {
        const [symbol,testnet]=all[this.cursor++%all.length],old=this.entries.get(symbol);
        if(old&&old.testnet===testnet&&now-old.receivedAt<60000)continue;
        try {
          const r=await get('/v5/market/kline',{category:'linear',symbol,interval:'1',limit:80},testnet);
          const bars=(r.result?.list||[]).map(x=>({ts:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]),turnover:Number(x[6])}))
            .filter(x=>x.ts+60000<=r.receivedAt).sort((a,b)=>a.ts-b.ts);
          this.entries.delete(symbol);this.entries.set(symbol,{testnet,bars,sourceAt:r.sourceAt,receivedAt:r.receivedAt});
          while(this.entries.size>120)this.entries.delete(this.entries.keys().next().value);
        }catch(e){onError(e,{symbol,subsystem:'PRIOR_NOISE',affectedRecordType:'decision_measurement',retry:'NEXT_CACHE_ROTATION'});}
      }
    }finally{this.busy=false;}
  }
}
module.exports={MeasurementCache};
