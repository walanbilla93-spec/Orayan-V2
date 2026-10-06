"""Verbatim V5 functions, extracted without executing upstream study code."""
from decimal import Decimal
from frozen_features import np,pd,B

def wilder(x,n=14):
 x=np.asarray(x,float);z=np.full(len(x),np.nan);start=None
 for i in range(len(x)):
  if not np.isfinite(x[i]):start=None;continue
  if start is None:start=i
  if i-start+1<n:continue
  z[i]=np.mean(x[start:i+1]) if i-start+1==n else (z[i-1]*(n-1)+x[i])/n
 return z

def bar_descriptors(b):
 out=pd.DataFrame(index=b.index);t=b.timestamp_ms.to_numpy();grp=np.cumsum(np.r_[True,np.diff(t)!=B]);c=b.close.to_numpy();h=b.high.to_numpy();l=b.low.to_numpy()
 for idx in pd.Series(np.arange(len(b))).groupby(grp):
  ix=idx[1].to_numpy();cc=c[ix];hh=h[ix];ll=l[ix];prev=np.r_[np.nan,cc[:-1]];tr=np.maximum.reduce([hh-ll,abs(hh-prev),abs(ll-prev)]);tr[0]=hh[0]-ll[0]
  up=np.r_[np.nan,np.diff(hh)];down=np.r_[np.nan,-np.diff(ll)];plus=np.where((up>down)&(up>0),up,0.);minus=np.where((down>up)&(down>0),down,0.);plus[0]=minus[0]=np.nan
  smtr=wilder(tr);di1=100*wilder(plus)/np.where(smtr>0,smtr,np.nan);di2=100*wilder(minus)/np.where(smtr>0,smtr,np.nan);den=di1+di2;dx=np.where(den>0,100*abs(di1-di2)/den,np.where(np.isfinite(den),0,np.nan));adx=wilder(dx)
  ch=np.r_[np.nan,np.diff(cc)];gain=wilder(np.maximum(ch,0));loss=wilder(np.maximum(-ch,0));rsi=np.where(loss>0,100-100/(1+gain/loss),np.where(gain>0,100,np.where(np.isfinite(gain),50,np.nan)))
  ema=pd.Series(cc).ewm(span=25,adjust=False,min_periods=100).mean();slope=abs(ema-ema.shift(4)).to_numpy()
  out.loc[ix,'adx14']=adx;out.loc[ix,'rsi14']=rsi;out.loc[ix,'ema_slope']=slope
  out.loc[ix,'ret30']=10000*np.log(cc/pd.Series(cc).shift(2).to_numpy());out.loc[ix,'ret60']=10000*np.log(cc/pd.Series(cc).shift(4).to_numpy());out.loc[ix,'extension']=cc-pd.Series(cc).shift(4).to_numpy()
  # Exact V1 pivots; confirmation after two subsequent completed bars.
  highd=[Decimal(x) for x in b.high_raw.iloc[ix]];lowd=[Decimal(x) for x in b.low_raw.iloc[ix]];ph=pl=np.nan;phs=np.full(len(ix),np.nan);pls=phs.copy()
  for k,j in enumerate(ix):
   if k>=4:
    a=k-2
    if all(highd[a]>highd[v] for v in [a-2,a-1,a+1,a+2]):ph=float(highd[a])
    if all(lowd[a]<lowd[v] for v in [a-2,a-1,a+1,a+2]):pl=float(lowd[a])
   phs[k]=ph;pls[k]=pl
  out.loc[ix,'pivot_high']=phs;out.loc[ix,'pivot_low']=pls
 return out
