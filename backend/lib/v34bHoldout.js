'use strict';
const fs=require('fs'),path=require('path'),{atomic}=require('./v34bCapture'),{DEFINITIONS}=require('./v34bResearch');
class Holdout {
  constructor(dir){this.file=path.join(dir,'holdout-v34b.json');this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):
    {version:DEFINITIONS.version,startedAt:null,episodes:{},admissions:{},armStats:{},researchOnly:true,executionAllowed:false};
    const revision=require('../validation/v34b-capture-validation.json').captureRevision;
    if(this.state.startedAt&&revision&&this.state.validation?.captureRevision!==revision){
      const preserved='holdout-v34b-validation-'+this.state.startedAt+'.json';
      atomic(path.join(dir,preserved),this.state);
      const previousCohorts=[...(this.state.previousCohorts||[]),{cohortId:this.state.cohortId,startedAt:this.state.startedAt,
        preservedFile:preserved,reason:'PRE_DELTA_CAPTURE_VALIDATION_COHORT'}];
      this.state={version:DEFINITIONS.version,startedAt:null,episodes:{},admissions:{},armStats:{},previousCohorts,researchOnly:true,executionAllowed:false};this.save();
    }
  }
  start(control,configHash,now){if(this.state.startedAt)return;
    const attestation=require('../validation/v34b-capture-validation.json');
    if(!attestation.passed||attestation.controlFingerprint!==control.fingerprint)throw Error('HOLDOUT_VALIDATION_NOT_PASSED');
    Object.assign(this.state,{startedAt:now,cohortId:'V34B_CLEAN_HOLDOUT_'+new Date(now).toISOString(),control,configHash,definitions:DEFINITIONS,validation:attestation});this.save();
  }
  admission(t,regime){if(!this.state.startedAt)return;
    const e=this.state.episodes[t.episodeId]||(this.state.episodes[t.episodeId]={symbol:t.symbol,side:t.side,regime,admissions:0,firstFillAt:null,repeatEligible:false,atrEligible:false});
    e.admissions++;e.repeatEligible=e.admissions>1;
    e.atrEligible=e.atrEligible||Boolean(t.research35?.arms.ATR1M_BUFFER.eligible);
    this.state.admissions[t.tradeId]={episodeId:t.episodeId,status:t.status,filledAt:null,netPnl:null};this.update(t);
  }
  episode(id){return this.state.episodes[id]||{};}
  update(t){const a=this.state.admissions[t.tradeId];if(!a)return;
    Object.assign(a,{status:t.status,filledAt:t.filledAt,netPnl:t.netPnl??null,resolved:t.outcomeComplete,censored:t.status==='DATA_GAP',arms:t.research35?.arms});
    // Store descriptive totals rather than complete simulator copies in metadata.
    if(a.arms) a.arms=Object.fromEntries(Object.entries(a.arms).map(([k,v])=>[k,{status:v.status,eligible:v.eligible,repeatEligible:v.repeatEligible,
      fillStatus:v.fillStatus,outcome:v.outcome,opportunityNetCash:v.opportunityNetCash,netR:v.netR,complete:v.complete,
      holdMs:v.holdMs??null,controlOutcome:t.outcome,controlNetCash:t.netPnl??null,controlNetR:t.realizedR??null,
      controlWinnerWithReceipts:k==='RECEIPT_DEFENDED_TRAILING'&&t.netPnl>0&&v.receiptCount>0}]));
    const e=this.state.episodes[t.episodeId];if(t.filledAt&&!e.firstFillAt)e.firstFillAt=t.filledAt;
    if(t.fillEconomics?.costAdjustedRR>=5)e.highRR=true;
    this.save();
  }
  save(){atomic(this.file,this.state);}
  status(now=Date.now()){
    const es=Object.values(this.state.episodes),filled=es.filter(e=>e.firstFillAt),symbols={},regimes={};
    for(const e of filled){symbols[e.symbol]=(symbols[e.symbol]||0)+1;regimes[e.regime]=(regimes[e.regime]||0)+1;}
    const stats={};for(const a of Object.values(this.state.admissions))for(const [policy,p] of Object.entries(a.arms||{})){
      const s=stats[policy]||(stats[policy]={eligibleAdmissions:0,suppressed:0,rejected:0,filled:0,resolved:0,netCash:0,pairedNetCash:0,censored:0,
        targets:0,immediateStops:0,controlWinnerDamageCash:0,opportunityLossCash:0,pairedResolved:0});
      if(!p.eligible)continue;s.eligibleAdmissions++;if(p.status==='SUPPRESSED')s.suppressed++;
      if(p.status==='REJECTED_BY_BUFFER_GEOMETRY')s.rejected++;if(p.fillStatus==='FILLED')s.filled++;
      if(p.outcome?.startsWith('TARGET'))s.targets++;if(p.outcome?.startsWith('STOP')&&p.holdMs<=300000)s.immediateStops++;
      if(Number.isFinite(p.opportunityNetCash)){s.resolved++;s.netCash+=p.opportunityNetCash;if(Number.isFinite(a.netPnl)){
        const delta=p.opportunityNetCash-a.netPnl;s.pairedNetCash+=delta;s.pairedResolved++;
        if(a.netPnl>0&&delta<0)s.controlWinnerDamageCash-=delta;if(p.opportunityNetCash===0&&a.netPnl>0)s.opportunityLossCash+=a.netPnl;
      }}
      if(p.status==='DATA_GAP')s.censored++;
    }
    return {cohortId:this.state.cohortId||null,startedAt:this.state.startedAt,previousCohorts:this.state.previousCohorts||[],control:this.state.control,configHash:this.state.configHash,
      uniqueFilledEpisodes:filled.length,distinctSymbols:Object.keys(symbols).length,longEpisodes:filled.filter(e=>e.side==='BUY').length,
      shortEpisodes:filled.filter(e=>e.side==='SELL').length,regimeCounts:regimes,symbolCounts:symbols,
      maxSymbolShare:filled.length?Math.max(...Object.values(symbols))/filled.length:0,
      repeatEligibleEpisodes:es.filter(e=>e.repeatEligible).length,atrBufferEligibleFilledEpisodes:filled.filter(e=>e.atrEligible).length,
      highRRUniqueEpisodes:filled.filter(e=>e.highRR).length,calendarDays:this.state.startedAt?(now-this.state.startedAt)/86400000:0,
      trailingEligibleUniqueEpisodes:new Set(Object.values(this.state.admissions).filter(a=>a.arms?.RECEIPT_DEFENDED_TRAILING&&a.arms.RECEIPT_DEFENDED_TRAILING.status!=='DORMANT').map(a=>a.episodeId)).size,
      trailingControlWinnersWithReceipts:Object.values(this.state.admissions).filter(a=>a.arms?.RECEIPT_DEFENDED_TRAILING?.controlWinnerWithReceipts).length,
      unresolvedAdmissions:Object.values(this.state.admissions).filter(a=>!a.resolved&&!a.censored).length,
      explicitlyCensoredAdmissions:Object.values(this.state.admissions).filter(a=>a.censored).length,
      pairedArms:stats,milestones:DEFINITIONS.review,monitoringOnly:true,executionAllowed:false};
  }
}
module.exports={Holdout};
