'use strict';
const fs=require('fs'),path=require('path'),{atomic}=require('./v34bCapture'),{DEFINITIONS}=require('./v34bResearch');
class Holdout {
  constructor(dir){this.file=path.join(dir,'holdout-v34b.json');this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):
    {version:DEFINITIONS.version,startedAt:null,episodes:{},admissions:{},armStats:{},researchOnly:true,executionAllowed:false};
    const revision=require('../validation/v34b-capture-validation.json').captureRevision;
    const minimalFile=path.join(dir,'..','capture-minimal-policy.json');
    const sameMinimalEpoch=fs.existsSync(minimalFile)&&JSON.parse(fs.readFileSync(minimalFile,'utf8')).epochId===this.state.cohortId;
    if(this.state.startedAt&&revision&&!sameMinimalEpoch&&this.state.validation?.captureRevision!==revision){
      const preserved='holdout-v34b-validation-'+this.state.startedAt+'.json';
      atomic(path.join(dir,preserved),this.state);
      const previousCohorts=[...(this.state.previousCohorts||[]),{cohortId:this.state.cohortId,startedAt:this.state.startedAt,
        preservedFile:preserved,reason:'CAPTURE_VALIDATION_REVISION_CHANGED',status:'capture-incomplete/exploratory',excludedFromNewAnalyticalCohort:true}];
      // A migration hour already contains old-format traffic and its exhausted quota.
      // Begin prospective collection on the next full UTC hour, never relabel it clean.
      const boundary=Math.max(Math.ceil(this.state.startedAt/3600000)*3600000,Math.floor(Date.now()/3600000)*3600000);
      this.state={version:DEFINITIONS.version,startedAt:null,notBeforeAt:boundary,
        episodes:{},admissions:{},armStats:{},previousCohorts,awaitingLiveQualification:true,researchOnly:true,executionAllowed:false};this.save();
    }
  }
  start(control,configHash,now,qualification=null){if(this.state.startedAt||now<(this.state.notBeforeAt||0))return;
    const attestation=require('../validation/v34b-capture-validation.json');
    if(!attestation.passed||attestation.controlFingerprint!==control.fingerprint)throw Error('HOLDOUT_VALIDATION_NOT_PASSED');
    if(attestation.requiresLiveQualification&&!qualification?.passed)return;
    Object.assign(this.state,{startedAt:now,cohortId:'V34B_CLEAN_HOLDOUT_'+new Date(now).toISOString(),control,configHash,definitions:DEFINITIONS,validation:attestation,
      qualification,awaitingLiveQualification:false,analyticalStatus:'COLLECTING_UNQUALIFIED_HOURS'});this.save();
  }
  admission(t,regime){if(!this.state.startedAt)return;
    const e=this.state.episodes[t.episodeId]||(this.state.episodes[t.episodeId]={symbol:t.symbol,side:t.side,regime,admissions:0,firstFillAt:null,repeatEligible:false,atrEligible:false});
    if(t.controlGeometryRejected)e.replacementGeometryOpportunities=(e.replacementGeometryOpportunities||0)+1;
    else e.admissions++;
    e.repeatEligible=e.admissions>1;
    e.atrEligible=e.atrEligible||Boolean(t.research35?.arms.ATR1M_BUFFER?.eligible);
    this.state.admissions[t.tradeId]={episodeId:t.episodeId,status:t.status,filledAt:null,netPnl:null};this.update(t);
  }
  episode(id){return this.state.episodes[id]||{};}
  update(t){const a=this.state.admissions[t.tradeId];if(!a)return;
    Object.assign(a,{status:t.status,filledAt:t.filledAt,netPnl:t.netPnl??null,resolved:t.outcomeComplete,censored:t.status==='DATA_GAP',arms:t.research35?.arms});
    // Store descriptive totals rather than complete simulator copies in metadata.
    if(a.arms) a.arms=Object.fromEntries(Object.entries(a.arms).map(([k,v])=>[k,{status:v.status,eligible:v.eligible,repeatEligible:v.repeatEligible,
      fillStatus:v.fillStatus,outcome:v.outcome,opportunityNetCash:v.opportunityNetCash,netR:v.netR,complete:v.complete,
      holdMs:v.holdMs??null,controlStatus:t.status,controlOutcome:t.outcome,controlNetCash:t.netPnl??null,controlNetR:t.realizedR??null,
      controlWinnerWithReceipts:k==='RECEIPT_DEFENDED_TRAILING'&&t.netPnl>0&&v.receiptCount>0,
      decisionGeometryRejected:v.decisionGeometryRejected,fillGeometryRejected:v.fillGeometryRejected,matchedFillSubset:v.matchedFillSubset,
      fullGeometrySubset:v.fullGeometrySubset,newlyAdmittedOpportunity:v.newlyAdmittedOpportunity,firstAdmissionSensitivity:v.firstAdmissionSensitivity,
      side:t.side,symbol:t.symbol,regime:t.regime,episodeId:t.episodeId}]));
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
      s.label='Prospective shadow research · no promotion';s.decisionGeometryRejects=(s.decisionGeometryRejects||0)+(p.decisionGeometryRejected?1:0);
      const pairedControl=p.status==='PAIRED_CONTROL',closed=p.status==='CLOSED'||(pairedControl&&(p.controlStatus==='CLOSED'||(!p.controlStatus&&p.fillStatus==='FILLED'&&(p.outcome?.startsWith('TARGET')||p.outcome?.startsWith('STOP')||p.outcome==='TIMEOUT'))));
      s.fillGeometryRejects=(s.fillGeometryRejects||0)+(p.fillGeometryRejected?1:0);s.closes=(s.closes||0)+(closed?1:0);
      s.open=(s.open||0)+(p.status==='OPEN'||(pairedControl&&(p.controlStatus==='OPEN'||(!p.controlStatus&&p.fillStatus==='FILLED'&&!p.outcome)))?1:0);s.stops=(s.stops||0)+(p.outcome?.startsWith('STOP')?1:0);
      s.timeouts=(s.timeouts||0)+(p.outcome==='TIMEOUT'?1:0);s.gaps=(s.gaps||0)+(p.outcome?.includes('GAP')?1:0);
      s.matchedFillSubset=(s.matchedFillSubset||0)+(p.matchedFillSubset?1:0);s.fullGeometrySubset=(s.fullGeometrySubset||0)+(p.fullGeometrySubset?1:0);
      s.newlyAdmittedOpportunities=(s.newlyAdmittedOpportunities||0)+(p.newlyAdmittedOpportunity?1:0);
      s.firstAdmissionSensitivity=(s.firstAdmissionSensitivity||0)+(p.firstAdmissionSensitivity?1:0);
      s.netR=(s.netR||0)+(Number.isFinite(p.netR)?p.netR:0);s.rescuedControlLosses=(s.rescuedControlLosses||0)+(a.netPnl<0&&p.opportunityNetCash>0?1:0);
      s.damagedControlWinners=(s.damagedControlWinners||0)+(a.netPnl>0&&Number.isFinite(p.opportunityNetCash)&&p.opportunityNetCash<a.netPnl?1:0);
      s.concentration??={side:{},regime:{},symbol:{}};for(const k of ['side','regime','symbol']){const v=p[k]||'UNKNOWN';s.concentration[k][v]=(s.concentration[k][v]||0)+1;}
      s.subsets??={matchedFill:{opportunities:0,resolved:0,netCash:0,netR:0},fullGeometry:{opportunities:0,resolved:0,netCash:0,netR:0}};
      for(const [key,included] of [['matchedFill',p.matchedFillSubset],['fullGeometry',p.fullGeometrySubset]])if(included){const subset=s.subsets[key];subset.opportunities++;
        if(Number.isFinite(p.opportunityNetCash)){subset.resolved++;subset.netCash+=p.opportunityNetCash;subset.netR+=Number.isFinite(p.netR)?p.netR:0;}}
      if(['REJECTED_BY_BUFFER_GEOMETRY','REJECTED_BY_REPLACEMENT_GEOMETRY'].includes(p.status))s.rejected++;if(p.fillStatus==='FILLED')s.filled++;
      if(p.outcome?.startsWith('TARGET'))s.targets++;if(p.outcome?.startsWith('STOP')&&p.holdMs<=300000)s.immediateStops++;
      if(Number.isFinite(p.opportunityNetCash)){s.resolved++;s.netCash+=p.opportunityNetCash;if(Number.isFinite(a.netPnl)){
        const delta=p.opportunityNetCash-a.netPnl;s.pairedNetCash+=delta;s.pairedResolved++;
        if(a.netPnl>0&&delta<0)s.controlWinnerDamageCash-=delta;if(p.opportunityNetCash===0&&a.netPnl>0)s.opportunityLossCash+=a.netPnl;
      }}
      if(p.status==='DATA_GAP'||(pairedControl&&(p.controlStatus==='DATA_GAP'||p.fillStatus==='DATA_GAP')))s.censored++;
    }
    for(const [policy,s] of Object.entries(stats)){s.uniqueEpisodes=new Set(Object.values(this.state.admissions).filter(a=>a.arms?.[policy]?.eligible).map(a=>a.episodeId)).size;
      s.uniqueFilledEpisodes=new Set(Object.values(this.state.admissions).filter(a=>a.arms?.[policy]?.fillStatus==='FILLED').map(a=>a.episodeId)).size;}
    stats.ATR1M_1P5_REPLACEMENT??={label:'Prospective shadow research · no promotion',eligibleAdmissions:0,suppressed:0,rejected:0,filled:0,closes:0,open:0,
      targets:0,stops:0,timeouts:0,gaps:0,censored:0,resolved:0,decisionGeometryRejects:0,fillGeometryRejects:0,uniqueEpisodes:0,uniqueFilledEpisodes:0,
      netCash:0,netR:0,pairedNetCash:0,rescuedControlLosses:0,damagedControlWinners:0,newlyAdmittedOpportunities:0,matchedFillSubset:0,fullGeometrySubset:0,
      firstAdmissionSensitivity:0,concentration:{side:{},regime:{},symbol:{}},subsets:{matchedFill:{opportunities:0,resolved:0,netCash:0,netR:0},fullGeometry:{opportunities:0,resolved:0,netCash:0,netR:0}}};
    return {cohortId:this.state.cohortId||null,startedAt:this.state.startedAt,awaitingLiveQualification:this.state.awaitingLiveQualification??true,qualification:this.state.qualification,
      notBeforeAt:this.state.notBeforeAt||null,previousCohorts:this.state.previousCohorts||[],control:this.state.control,configHash:this.state.configHash,
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
