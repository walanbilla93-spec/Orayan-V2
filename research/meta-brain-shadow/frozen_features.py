import numpy as np, pandas as pd
M=60000
B=15*M
FEATURES=[{'feature_name': 'event_type', 'eligible_for_training': True}, {'feature_name': 'side', 'eligible_for_training': True}, {'feature_name': 'structural_level_age_bars', 'eligible_for_training': True}, {'feature_name': 'distance_to_level_atr', 'eligible_for_training': True}, {'feature_name': 'sweep_penetration_atr', 'eligible_for_training': True}, {'feature_name': 'failed_acceptance_atr', 'eligible_for_training': True}, {'feature_name': 'trigger_body_atr', 'eligible_for_training': True}, {'feature_name': 'trigger_range_atr', 'eligible_for_training': True}, {'feature_name': 'trigger_turnover_shock', 'eligible_for_training': True}, {'feature_name': 'pre15_rv_bps', 'eligible_for_training': True}, {'feature_name': 'pre15_abs_return_sum_bps', 'eligible_for_training': True}, {'feature_name': 'pre15_range_atr', 'eligible_for_training': True}, {'feature_name': 'pre15_turnover_intensity', 'eligible_for_training': True}, {'feature_name': 'pre15_sign_changes', 'eligible_for_training': True}, {'feature_name': 'pre30_rv_bps', 'eligible_for_training': True}, {'feature_name': 'pre30_abs_return_sum_bps', 'eligible_for_training': True}, {'feature_name': 'pre30_range_atr', 'eligible_for_training': True}, {'feature_name': 'pre30_turnover_intensity', 'eligible_for_training': True}, {'feature_name': 'pre30_sign_changes', 'eligible_for_training': True}, {'feature_name': 'pre60_rv_bps', 'eligible_for_training': True}, {'feature_name': 'pre60_abs_return_sum_bps', 'eligible_for_training': True}, {'feature_name': 'pre60_range_atr', 'eligible_for_training': True}, {'feature_name': 'pre60_turnover_intensity', 'eligible_for_training': True}, {'feature_name': 'pre60_sign_changes', 'eligible_for_training': True}, {'feature_name': 'pre120_rv_bps', 'eligible_for_training': True}, {'feature_name': 'pre120_abs_return_sum_bps', 'eligible_for_training': True}, {'feature_name': 'pre120_range_atr', 'eligible_for_training': True}, {'feature_name': 'pre120_turnover_intensity', 'eligible_for_training': True}, {'feature_name': 'pre120_sign_changes', 'eligible_for_training': True}, {'feature_name': 'atr15', 'eligible_for_training': True}, {'feature_name': 'atr_acceleration_pre', 'eligible_for_training': True}, {'feature_name': 'adx14', 'eligible_for_training': True}, {'feature_name': 'abs_ema25_slope4_atr', 'eligible_for_training': True}, {'feature_name': 'directional_return30_bps', 'eligible_for_training': True}, {'feature_name': 'directional_return60_bps', 'eligible_for_training': True}, {'feature_name': 'rsi14', 'eligible_for_training': True}, {'feature_name': 'strict_pre_extension_atr', 'eligible_for_training': True}, {'feature_name': 'oi_state', 'eligible_for_training': True}, {'feature_name': 'oi_change_5', 'eligible_for_training': True}, {'feature_name': 'oi_change_15', 'eligible_for_training': True}, {'feature_name': 'oi_change_30', 'eligible_for_training': True}, {'feature_name': 'oi_change_60', 'eligible_for_training': True}, {'feature_name': 'oi_acceleration', 'eligible_for_training': True}, {'feature_name': 'oi_z1d', 'eligible_for_training': True}, {'feature_name': 'oi_percentile1d', 'eligible_for_training': True}, {'feature_name': 'premium_z1d', 'eligible_for_training': True}, {'feature_name': 'premium_percentile1d', 'eligible_for_training': True}, {'feature_name': 'premium_level', 'eligible_for_training': True}, {'feature_name': 'funding_current', 'eligible_for_training': True}, {'feature_name': 'long_short_ratio', 'eligible_for_training': True}, {'feature_name': 'btc_return_5', 'eligible_for_training': True}, {'feature_name': 'btc_return_15', 'eligible_for_training': True}, {'feature_name': 'btc_return_30', 'eligible_for_training': True}, {'feature_name': 'btc_return_60', 'eligible_for_training': True}, {'feature_name': 'btc_shock60', 'eligible_for_training': True}, {'feature_name': 'relative_strength_btc', 'eligible_for_training': True}, {'feature_name': 'utc_hour', 'eligible_for_training': True}, {'feature_name': 'utc_day_of_week', 'eligible_for_training': True}]
def asof(d,col,q,lag=5*M,age=5*M):
 if d.empty:return np.full(len(q),np.nan),np.full(len(q),-1),np.full(len(q),np.nan)
 t=d.timestamp_ms.to_numpy(np.int64)+lag;ix=np.searchsorted(t,q,side='right')-1;s=np.maximum(ix,0);ok=(ix>=0)&(q-t[s]<=age)
 return np.where(ok,d[col].to_numpy()[s],np.nan),np.where(ok,ix,-1),np.where(ok,t[s],np.nan)

def exact(d,col,q):
 if d.empty:return np.full(len(q),np.nan)
 t=d.timestamp_ms.to_numpy(np.int64);i=np.searchsorted(t,q);s=np.minimum(i,len(t)-1);return np.where((i<len(t))&(t[s]==q),d[col].to_numpy()[s],np.nan)

def historical(d,col,ix,n):
 a=d[col].to_numpy(float);z=np.full(len(ix),np.nan);pct=z.copy()
 for k,j in enumerate(ix):
  if j<0:continue
  prev=a[max(0,j-n):j];prev=prev[np.isfinite(prev)]
  if len(prev)<96:continue
  sd=prev.std(ddof=1);z[k]=(a[j]-prev.mean())/sd if sd>0 else np.nan;pct[k]=np.mean(prev<=a[j])
 return z,pct

class Minutes:
 def __init__(self,m,b):
  self.m=m;self.b=b;self.t=m.timestamp_ms.to_numpy(np.int64);self.c=m.close.to_numpy(float);self.h=m.high.to_numpy(float);self.l=m.low.to_numpy(float);self.op=m.open.to_numpy(float);self.q=m.turnover_quote.to_numpy(float)
  assert len(self.t)>0 and (np.diff(self.t)>0).all()
  self.r=np.r_[np.nan,np.log(self.c[1:]/self.c[:-1])];self.r[1:][np.diff(self.t)!=M]=np.nan
  self.gap=np.r_[0,np.cumsum(np.diff(self.t)!=M)];self.cum={n:np.r_[0,np.cumsum(np.nan_to_num(v))] for n,v in [('rv',self.r**2),('abs',abs(self.r)),('turn',self.q)]};self.ext={}
  bc=b.close.to_numpy();tr=np.maximum.reduce([b.high-b.low,abs(b.high-np.r_[np.nan,bc[:-1]]),abs(b.low-np.r_[np.nan,bc[:-1]])]);tr[0]=b.high.iloc[0]-b.low.iloc[0]
  self.atr=pd.Series(tr).shift(1).rolling(14,min_periods=14).mean().to_numpy();i=np.searchsorted(b.knownAt,self.t,side='right')-1;self.minute_atr=np.where(i>=0,self.atr[np.maximum(i,0)],np.nan)
 def positions(self,q):
  i=np.searchsorted(self.t,q);s=np.minimum(i,len(self.t)-1);return i,(i<len(self.t))&(self.t[s]==q)
 def complete(self,start,h):
  i,ok=self.positions(start);last=i+h-1;s=np.clip(last,0,len(self.t)-1);p=np.maximum(i-1,0)
  return ok&(i>0)&(last<len(self.t))&(self.t[s]==start+(h-1)*M)&(self.gap[s]==self.gap[p])
 def sum(self,k,i,z):return self.cum[k][np.clip(z,0,len(self.t))]-self.cum[k][np.clip(i,0,len(self.t))]
 def metrics(self,start,h,atr,baseline):
  i,_=self.positions(start);z=i+h;s=np.clip(z-1,0,len(self.t)-1);valid=self.complete(start,h)
  if h not in self.ext:self.ext[h]=(pd.Series(self.h).rolling(h).max().to_numpy(),pd.Series(self.l).rolling(h).min().to_numpy())
  high,low=[v[s] for v in self.ext[h]];idx=np.minimum(i[:,None]+np.arange(h),len(self.t)-1);r=self.r[idx];sign=np.sign(r);prev=np.zeros(len(i));sc=np.zeros(len(i))
  for k in range(h):
   v=sign[:,k];nz=np.isfinite(v)&(v!=0);sc+=(nz&(prev!=0)&(v!=prev));prev=np.where(nz,v,prev)
  vals={'rv_bps':1e4*np.sqrt(np.maximum(0,self.sum('rv',i,z))),'abs_return_sum_bps':1e4*self.sum('abs',i,z),'range_atr':(high-low)/atr,'turnover_intensity':self.sum('turn',i,z)/h/baseline,'sign_changes':sc,'atr_acceleration':(self.minute_atr[s]-self.minute_atr[np.minimum(i,len(self.t)-1)])/atr}
  return {k:np.where(valid,v,np.nan) for k,v in vals.items()},valid

def causal_features(e,m,b,btc,sp,s,aux):
 q=e.knownAt.to_numpy(np.int64);bi=e.bar_index.to_numpy(int);prev=bi-1;di=e.direction.to_numpy();eng=Minutes(m,b);atr=eng.atr[bi];assert np.allclose(atr,e.atr,equal_nan=True,rtol=0,atol=1e-12)
 f={'event_type':e.eventType.to_numpy(),'side':di,'structural_level_age_bars':(q-e.level_knownAt)/B,'distance_to_level_atr':di*(b.close.to_numpy()[bi]-e.level)/atr,'atr15':atr}
 f['sweep_penetration_atr']=np.where(e.eventType=='SWEEP',np.where(di==1,e.level-b.low.to_numpy()[bi],b.high.to_numpy()[bi]-e.level)/atr,np.nan)
 f['failed_acceptance_atr']=np.where(e.eventType=='SWEEP',f['distance_to_level_atr'],np.nan)
 f['trigger_body_atr']=abs(b.close.to_numpy()[bi]-b.open.to_numpy()[bi])/atr;f['trigger_range_atr']=(b.high.to_numpy()[bi]-b.low.to_numpy()[bi])/atr
 f['trigger_turnover_shock']=np.log(b.turnover.to_numpy()[bi]/b.turnover.shift(1).rolling(96,min_periods=96).mean().to_numpy()[bi])
 baseline=eng.sum('turn',*tuple(np.searchsorted(eng.t,x) for x in [q-1560*M,q-120*M]))/1440;baseline=np.where(eng.complete(q-1560*M,1440)&(baseline>0),baseline,np.nan)
 tm={k:q.copy() for k in f};tm['atr15']=q-B
 for h in [15,30,60,120]:
  vals,_=eng.metrics(q-(h+15)*M,h,atr,baseline)
  for stem in ['rv_bps','abs_return_sum_bps','range_atr','turnover_intensity','sign_changes']:f[f'pre{h}_{stem}']=vals[stem];tm[f'pre{h}_{stem}']=q-B
 bd=bar_descriptors(b);valid=(prev>=0)&(b.knownAt.to_numpy()[prev]==q-B)
 for n,col in [('adx14','adx14'),('rsi14','rsi14')]:f[n]=np.where(valid,bd[col].to_numpy()[prev],np.nan);tm[n]=q-B
 f['abs_ema25_slope4_atr']=np.where(valid,bd.ema_slope.to_numpy()[prev]/atr,np.nan);tm['abs_ema25_slope4_atr']=q-B
 for h in [30,60]:f[f'directional_return{h}_bps']=np.where(valid,di*bd[f'ret{h}'].to_numpy()[prev],np.nan);tm[f'directional_return{h}_bps']=q
 f['strict_pre_extension_atr']=np.where(valid,di*bd.extension.to_numpy()[prev]/atr,np.nan);tm['strict_pre_extension_atr']=q
 f['atr_acceleration_pre']=(eng.atr[prev]-eng.atr[np.maximum(prev-4,0)])/atr;tm['atr_acceleration_pre']=q-B
 af,at,evidence=auxiliary(e,sp,s,aux);f.update(af);tm.update(at)
 for h in [5,15,30,60]:f[f'btc_return_{h}']=exact(btc,'close',q-M)/exact(btc,'close',q-(h+1)*M)-1;tm[f'btc_return_{h}']=q
 # BTC volatility baseline sampled at exactly the symbol completed15m close timestamps, as in V1.
 bc=pd.Series(exact(btc,'close',b.knownAt.to_numpy()-M));brv=np.log(bc/bc.shift(1)).pow(2).shift(1).rolling(96,min_periods=96).sum().pow(.5).to_numpy()
 f['btc_shock60']=f['btc_return_60']/brv[bi];tm['btc_shock60']=q
 f['relative_strength_btc']=b.close.to_numpy()[bi]/b.close.to_numpy()[bi-4]-1-f['btc_return_60'];tm['relative_strength_btc']=q
 dt=pd.to_datetime(q,unit='ms',utc=True);f['utc_hour']=dt.hour;f['utc_day_of_week']=dt.dayofweek;tm['utc_hour']=q;tm['utc_day_of_week']=q
 eligible=[r['feature_name'] for r in FEATURES if r['eligible_for_training']];assert set(f)==set(eligible)
 fd=pd.DataFrame({'event_id':e.event_id,**{'x__'+k:np.asarray(v) for k,v in f.items()}})
 audit=pd.DataFrame({'event_id':e.event_id,**{k+'__available_ms':v for k,v in tm.items()},**evidence,'trigger_source_start_ms':q-B,'trigger_source_end_ms':q-M,'pre_source_end_ms':q-16*M,'level_source_knownAt':e.level_knownAt,'momentum_alignment_available_ms':q,'btc_source_end_ms':q-M})
 for k in eligible:
  vals=fd['x__'+k];nonmissing=vals.notna()&(vals!='OI_MISSING')
  assert audit.loc[nonmissing,k+'__available_ms'].notna().all(),('TIMESTAMP_MISSING',k)
  assert (audit.loc[nonmissing,k+'__available_ms'].to_numpy()<=q[nonmissing]).all(),('FUTURE_FEATURE',k)
 assert (e.level_knownAt<q).all();assert (e.stop_knownAt.dropna()<=e.knownAt[e.stop_knownAt.notna()]).all()
 return fd,audit,eng,baseline
