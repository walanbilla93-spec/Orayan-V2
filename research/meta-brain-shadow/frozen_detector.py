from decimal import Decimal
from frozen_features import np,pd,M,B
def aggregate(m):
 if m.empty:return pd.DataFrame()
 # Decimal extrema from stored raw decimal strings, not float comparison.
 t=m.timestamp_ms.to_numpy(dtype=np.int64);groups=t//B
 high_raw=m.high_raw.to_numpy();low_raw=m.low_raw.to_numpy();close_raw=m.close_raw.to_numpy()
 opens=m.open.to_numpy();closes=m.close.to_numpy();volumes=m.volume_base.to_numpy();turnovers=m.turnover_quote.to_numpy()
 changes=np.r_[0,np.flatnonzero(np.diff(groups))+1,len(t)];rows=[]
 for a,z in zip(changes[:-1],changes[1:]):
  k=int(t[a]//B*B)
  if z-a!=15 or t[a]!=k or not np.array_equal(t[a:z],k+np.arange(15)*M):continue
  hi=max(map(Decimal,high_raw[a:z]));lo=min(map(Decimal,low_raw[a:z]))
  rows.append({'timestamp_ms':k,'knownAt':k+B,'open':float(opens[a]),'high':float(hi),'low':float(lo),'close':float(closes[z-1]),
   'high_raw':str(hi),'low_raw':str(lo),'close_raw':close_raw[z-1],
   'volume':float(volumes[a:z].sum()),'turnover':float(turnovers[a:z].sum())})
 return pd.DataFrame(rows)
def detect(b,symbol,warmup=200):
 events=[];levels={1:None,-1:None};pending={};run=0
 if b.empty:return pd.DataFrame()
 h=[Decimal(x) for x in b.high_raw];l=[Decimal(x) for x in b.low_raw];c=[Decimal(x) for x in b.close_raw]
 ts=b.timestamp_ms.to_numpy(dtype=np.int64)
 for i in range(len(b)):
  if i==0 or ts[i]-ts[i-1]!=B:levels={1:None,-1:None};pending={};run=0
  run+=1;known=int(ts[i]+B)
  born=[]
  for side in [1,-1]:
   lev=levels[side]
   if lev is None:continue
   close_break=c[i]>lev['value'] if side==1 else c[i]<lev['value']
   sweep=(h[i]>lev['value'] and c[i]<lev['value']) if side==1 else (l[i]<lev['value'] and c[i]>lev['value'])
   if close_break and not lev['broken']:
    lev['broken']=True;opp=levels[-side]
    ev={'symbol':symbol,'eventType':'BOS','direction':side,'knownAt':known,'bar_index':i,'level_id':lev['id'],'level':float(lev['value']),
     'level_knownAt':lev['knownAt'],'level_pivotAt':lev['pivotAt'],'stop':float(opp['value']) if opp else np.nan,'stop_knownAt':opp['knownAt'] if opp else None,'origin_sweep_id':None}
    ev['event_id']=f'{symbol}:BOS:{side}:{known}:{lev["id"]}'
    if run>=warmup:born.append(ev)
    sw=pending.get(side)
    if sw and 1<=i-sw['bar_index']<=8:
     seq=dict(ev,eventType='SEQUENCE',stop=sw['stop'],stop_knownAt=sw['knownAt'],origin_sweep_id=sw['event_id'],sweep_knownAt=sw['knownAt'],sweep_age_bars=i-sw['bar_index'])
     seq['event_id']=f'{symbol}:SEQUENCE:{side}:{known}:{sw["event_id"]}'
     if run>=warmup:born.append(seq)
     pending.pop(side,None)
   if sweep and not lev['swept']:
    lev['swept']=True;direction=-side
    ev={'symbol':symbol,'eventType':'SWEEP','direction':direction,'knownAt':known,'bar_index':i,'level_id':lev['id'],'level':float(lev['value']),
     'level_knownAt':lev['knownAt'],'level_pivotAt':lev['pivotAt'],'stop':float(h[i] if side==1 else l[i]),'stop_knownAt':known,'origin_sweep_id':None}
    ev['event_id']=f'{symbol}:SWEEP:{direction}:{known}:{lev["id"]}'
    if run>=warmup:born.append(ev)
    # Same-bar BoS already handled; sequence must follow on a subsequent bar.
    pending[direction]=ev
  events.extend(born)
  pending={d:s for d,s in pending.items() if i-s['bar_index']<8}
  if run>=5:
   j=i-2
   for side,vals in [(1,h),(-1,l)]:
    neighbors=[vals[j-2],vals[j-1],vals[j+1],vals[j+2]]
    pivot=all(vals[j]>x for x in neighbors) if side==1 else all(vals[j]<x for x in neighbors)
    if pivot:levels[side]={'value':vals[j],'knownAt':known,'pivotAt':int(ts[j]),'id':f'{side}:{ts[j]}','broken':False,'swept':False}
 return pd.DataFrame(events)
def oi_state(current,prior):
 if current is None or prior is None or pd.isna(current) or pd.isna(prior):return 'OI_MISSING'
 a,b=Decimal(str(current)),Decimal(str(prior))
 return 'OI_EXPANDING' if a>b else 'OI_CONTRACTING' if a<b else 'OI_FLAT'
