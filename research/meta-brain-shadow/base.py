"""Exact frozen feature math plus live receipt-aware data adapter."""
import json, time, hashlib, sys
from pathlib import Path
import numpy as np, pandas as pd, joblib, sklearn
import frozen_features as ff
from frozen_detector import aggregate,detect,oi_state
from frozen_indicators import bar_descriptors
from storage import clean,digest
ff.bar_descriptors=bar_descriptors
M=60000;B=15*M

class LiveAux:
    def __init__(self): self.rows={};self.decision_ms=0;self.used_receipts=[]
    def add(self,s,stream,row):
        key=(s,stream);self.rows.setdefault(key,{}).setdefault(row['timestamp_ms'],row)
        # Retain first actual receipt for a source publication; revisions never replace it.
        self.rows[key]=dict(sorted(self.rows[key].items())[-1600:])
    def load(self,sp,s,stream,cols):
        selected=[r for r in self.rows.get((s,stream),{}).values() if r['receipt_ms']<=self.decision_ms]
        self.used_receipts.extend(r['receipt_ms'] for r in selected)
        return pd.DataFrame(selected,columns=cols).sort_values('timestamp_ms').reset_index(drop=True)

def live_auxiliary(e,sp,s,aux):
    q=e.knownAt.to_numpy(np.int64);f={};tm={};evidence={}
    # The original Phase1 availability lag remains a minimum; actual receipt is an additional gate.
    oi=aux.load(sp,s,'oi_5m',['timestamp_ms','open_interest','open_interest_raw'])
    cur,ix,avail=ff.asof(oi,'open_interest',q);old15,jx,t15=ff.asof(oi,'open_interest',q-15*M)
    raw=oi.open_interest_raw.to_numpy() if len(oi) else []
    f['oi_state']=np.array([oi_state(raw[a] if a>=0 else None,raw[b] if b>=0 else None) for a,b in zip(ix,jx)])
    tm['oi_state']=np.where((ix>=0)&(jx>=0),avail,np.nan)
    for h in [5,15,30,60]:
        old,_,oldtm=ff.asof(oi,'open_interest',q-h*M)
        f[f'oi_change_{h}']=cur/old-1;tm[f'oi_change_{h}']=np.where(np.isfinite(oldtm)&np.isfinite(avail),avail,np.nan)
    old30,_,t30=ff.asof(oi,'open_interest',q-30*M)
    f['oi_acceleration']=f['oi_change_15']-(old15/old30-1);tm['oi_acceleration']=np.where(np.isfinite(t30),avail,np.nan)
    for metric,v in zip(['z1d','percentile1d'],ff.historical(oi,'open_interest',ix,288)):
        f['oi_'+metric]=v;tm['oi_'+metric]=avail
    prem=aux.load(sp,s,'premium_1m',['timestamp_ms','close']);f['premium_level']=ff.exact(prem,'close',q-M);tm['premium_level']=q
    if len(prem):
        pi=np.searchsorted(prem.timestamp_ms.to_numpy(),q-M);ps=np.minimum(pi,len(prem)-1)
        pi=np.where((pi<len(prem))&(prem.timestamp_ms.to_numpy()[ps]==q-M),pi,-1)
    else:pi=np.full(len(q),-1)
    for metric,v in zip(['z1d','percentile1d'],ff.historical(prem,'close',pi,1440)):
        f['premium_'+metric]=v;tm['premium_'+metric]=np.where(pi>=0,q,np.nan)
    ls=aux.load(sp,s,'long_short_5m',['timestamp_ms','buy_ratio_raw','sell_ratio_raw'])
    ls['ratio']=pd.to_numeric(ls.buy_ratio_raw)/pd.to_numeric(ls.sell_ratio_raw).replace(0,np.nan)
    f['long_short_ratio'],_,tm['long_short_ratio']=ff.asof(ls,'ratio',q)
    funding=aux.load(sp,s,'funding',['timestamp_ms','funding_rate'])
    f['funding_current'],_,tm['funding_current']=ff.asof(funding,'funding_rate',q,age=24*60*M)
    return f,tm,evidence
ff.auxiliary=live_auxiliary

class Base:
    def __init__(self,folder,config):
        self.folder=Path(folder);self.config=config;self.lock=json.loads((self.folder/'model_lock.json').read_text())
        if sklearn.__version__!='1.9.1':raise RuntimeError('Phase3A sklearn version mismatch')
        for name,expected in self.lock['files'].items():
            if hashlib.sha256((self.folder/name).read_bytes()).hexdigest()!=expected:raise RuntimeError('MODEL_LOCK_MISMATCH '+name)
        self.models={h:joblib.load(self.folder/'models'/f'fold3_{h}_locked.joblib') for h in ['A','B','C']}
        for h,obj in self.models.items():
            if obj['metadata']['features']!=self.lock['features'] or obj['metadata']['spec_sha256']!=self.lock['spec_sha256']:
                raise RuntimeError('model_metadata_mismatch')
        self.refs=json.loads((self.folder/'models/fold3_D_references.json').read_text())
        self.uncertainty=joblib.load(self.folder/'models/fold3_A_locked_uncertainty.joblib')
        self.minutes={s:{} for s in config['symbols']};self.aux=LiveAux();self.drift_score=None

    def minute(self,s,row):
        # A completed bar is immutable. REST bootstrap lives in a separate provenance partition.
        if row['timestamp_ms'] in self.minutes[s]:return
        self.minutes[s][row['timestamp_ms']]=row
        self.minutes[s]=dict(sorted(self.minutes[s].items())[-7500:])

    def frames(self,s):
        return pd.DataFrame(self.minutes[s].values()).sort_values('timestamp_ms').reset_index(drop=True)

    def observations(self,s,decision_ms,boundary_ms):
        m=self.frames(s);btc=self.frames('BTCUSDT')
        if len(m)<3000 or len(btc)<3000:return [],{'status':'warming','symbol':s,'minutes':len(m)}
        b=aggregate(m);e=detect(b,s)
        state=self.state_snapshot(s,m,b,decision_ms)
        if e.empty:return [],state
        latest=int(b.knownAt.max());e=e[(e.eventType.isin(['BOS','SWEEP']))&(e.knownAt==latest)].copy().reset_index(drop=True)
        if e.empty:return [],state
        eng=ff.Minutes(m,b);e['atr']=eng.atr[e.bar_index.to_numpy(int)]
        self.aux.decision_ms=decision_ms;self.aux.used_receipts=[]
        fd,audit,_,_=ff.causal_features(e,m,b,btc,'live',s,self.aux)
        used=list(m.receipt_ms)+list(btc.receipt_ms)+self.aux.used_receipts
        if max(used)>decision_ms:raise RuntimeError('FUTURE_RECEIPT')
        result=[]
        for i,event in e.iterrows():
            snapshot=clean(fd.iloc[i][self.lock['features']].to_dict())
            result.append(self.predict(snapshot,event.to_dict(),decision_ms,boundary_ms,max(used),audit.iloc[i].to_dict()))
        return result,{'status':'live_snapshot','symbol':s,'latest_bar_clock_ms':latest,'eligible_events':len(result)}

    def state_snapshot(self,s,m,b,at):
        q=int(b.knownAt.iloc[-1]);eng=ff.Minutes(m,b);atr=eng.atr[-1]
        vals,_=eng.metrics(np.array([q-75*M]),60,np.array([atr]),np.array([np.nan]))
        descriptors=bar_descriptors(b)
        values={'atr15':float(atr),'pre60_rv_bps':float(vals['rv_bps'][0]),
                'pre60_abs_return_sum_bps':float(vals['abs_return_sum_bps'][0]),
                'pre60_range_atr':float(vals['range_atr'][0]),'adx14_pre':float(descriptors.adx14.iloc[-2]),
                'rsi14_pre':float(descriptors.rsi14.iloc[-2]),'latest_completed_close':float(m.close.iloc[-1])}
        return {'status':'live_feature_snapshot','symbol':s,'latest_bar_clock_ms':q,'latest_minute_ms':int(m.timestamp_ms.iloc[-1]),
                'latest_minute_receipt_ms':int(m.receipt_ms.iloc[-1]),'decision_ms':at,'eligible_events':0,
                'live_feature_snapshot':clean(values),'snapshot_hash':digest(values),
                'predictions_omitted':'no eligible BOS/SWEEP event; generic state is outside frozen training cohort'}

    def predict(self,snapshot,event,at,boundary_ms,max_receipt,availability):
        x=pd.DataFrame([snapshot],columns=self.lock['features'])
        cats=['x__event_type','x__oi_state']
        for c in x.columns:
            if c not in cats:x[c]=pd.to_numeric(x[c],errors='coerce')
        predictions={}
        for h,obj in self.models.items():
            est=obj['calibrated_model'] if obj['calibrated_model'] is not None else obj['raw_model']
            predictions[h]=float(est.predict(x)[0] if h=='A' else est.predict_proba(x)[0,1])
        missing=[c for c,v in snapshot.items() if v is None or v=='OI_MISSING']
        num=list(self.refs['train_q01']);outside=0;maxexcess=0
        for c in num:
            v=snapshot[c];lo=self.refs['train_q01'][c];hi=self.refs['train_q99'][c]
            if v is not None and lo is not None and hi is not None:
                outside+=int(v<lo or v>hi)
                if hi>lo:maxexcess=max(maxexcess,max(lo-v,v-hi,0)/(hi-lo))
        category_refs=self.refs['categorical_vocabulary']
        unseen=sum(snapshot[c] not in category_refs.get(c,[snapshot[c]]) for c in cats)/2
        ood=(outside/len(num)+maxexcess/(1+maxexcess)+unseen)/3
        q=int(event['knownAt']);oid=digest({'event_id':event['event_id'],'model_hash':self.lock['files']['models/fold3_A_locked.joblib']})
        u=self.uncertainty;pre=snapshot['x__pre60_rv_bps']
        cell=int(np.digitize(pre,u['train_pre60_edges'][1:-1])) if pre is not None else None
        stats=u['residual_cells'].iloc[cell].to_dict() if cell is not None else dict(zip(['MAE','SD','q90'],u['global_stats']))
        activity_diagnostic={'status':'frozen_earlier_calibration_residual_statistics','cell':cell,'statistics':clean(stats)}
        return {'observation_id':oid,'event_id':event['event_id'],'symbol':event['symbol'],'event_type':event['eventType'],
          'event_clock_ms':q,'event_timestamp':q-B,'decision_timestamp':at,'knownAt':at,'receipt_timestamp':at,
          'feature_max_receipt_ms':max_receipt,'feature_snapshot':snapshot,'feature_snapshot_hash':digest(snapshot),
          'feature_availability_audit':clean(availability),'head_A_prediction':predictions['A'],'head_B_probability':predictions['B'],
          'head_C_diagnostic':predictions['C'],'head_D':{'ood_score':ood,'activity_uncertainty':activity_diagnostic,'drift_score':self.drift_score,'drift_status':'available' if self.drift_score is not None else 'insufficient_prospective_history',
          'context_state':None,'policy':'UNCONFIGURED_INTERFACE_ONLY','critical_missing':any(c in missing for c in ['x__atr15','x__pre60_rv_bps','x__adx14','x__abs_ema25_slope4_atr'])},
          'missing_feature_mask':missing,'model_version':'phase3a-fold3-frozen','model_hashes':self.lock['files'],
          'schema_version':self.config['schema_version'],'shadow_only':True,'no_trade':True,'execution_enabled':False,
          'cohort':'prospective' if boundary_ms is not None and q>=boundary_ms and at>=boundary_ms else 'historical_bootstrap',
          'reference_entry_ms':q+M,'frozen_atr':float(event['atr']),'labels_written_separately':True,'flow_used_by_base':False}

    def update_drift(self,db,at):
        day=at//86400000*86400000
        if getattr(self,'drift_day',None)==day:return
        self.drift_day=day;start=day-14*86400000
        records=[json.loads(r[0]) for r in db.execute('SELECT record FROM predictions WHERE event_ms>=? AND event_ms<?',(start,day))]
        records=[r for r in records if r['cohort']=='prospective']
        if not records:self.drift_score=None;return
        values=[]
        for c,edges in self.refs['train_numeric_decile_edges'].items():
            # JSON non-finite end points were stored as null; restore histogram open tails.
            edges=np.array([(-np.inf if i==0 else np.inf) if v is None else v for i,v in enumerate(edges)],float)
            sample=[r['feature_snapshot'][c] for r in records if r['feature_snapshot'][c] is not None]
            if not sample:continue
            pa=np.maximum(self.refs['train_histogram_shares'][c],1e-6)
            pb=np.maximum(np.histogram(sample,edges)[0]/len(sample),1e-6)
            psi=float(np.sum((pb-pa)*np.log(pb/pa)));values.append(psi/(1+psi))
        self.drift_score=float(np.mean(values)) if values else None

    def mature_labels(self,row,at):
        q=row['event_clock_ms'];start=q+M;end=start+61*M
        if at<end:return None
        times=np.arange(start,start+61*M,M);data=self.minutes[row['symbol']]
        selected=[data.get(int(t)) for t in times];previous=data.get(start-M)
        if any(r is None or r['cohort']!='prospective' for r in selected) or previous is None or previous['cohort']!='prospective':
            return {'observation_id':row['observation_id'],'written_at':at,'status':'CENSORED_GAP_OR_BOOTSTRAP','horizon_minutes':60}
        closes=np.array([previous['close']]+[r['close'] for r in selected[:60]])
        rv=float(10000*np.sqrt(np.sum(np.log(closes[1:]/closes[:-1])**2)))
        entry=selected[0]['open'];atr=row['frozen_atr'];high=max(r['high'] for r in selected[:60]);low=min(r['low'] for r in selected[:60])
        two=float(high>=entry+atr and low<=entry-atr) if np.isfinite(atr) else None
        return {'observation_id':row['observation_id'],'written_at':at,'status':'MATURED','horizon_minutes':60,
                'head_A_realized_rv_bps':rv,'head_B_realized_two_sided_1atr':two,'reference_entry_price':entry,
                'label_clock':'Phase1 q+1m entry, 60 future completed minutes; one additional completed minute continuity check',
                'max_source_receipt_ms':max(r['receipt_ms'] for r in selected)}
