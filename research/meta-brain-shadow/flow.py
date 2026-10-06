"""Receipt-clock flow proxies. Exact exchange decimal strings stay in raw storage."""
from decimal import Decimal
from collections import deque
import uuid

class Book:
    def __init__(self):
        self.bids={};self.asks={};self.u=None;self.seq=None;self.valid=False;self.receipt_ms=0;self.exchange_ms=0
        self.wall=None;self.wall_since=0;self.previous_depth=None

    def apply(self,msg,receipt_ms):
        d=msg['data'];u=int(d['u']);seq=int(d['seq']);snapshot=msg['type']=='snapshot' or u==1
        if not snapshot and (not self.valid or u<=self.u or seq<=self.seq):
            self.valid=False;raise ValueError('book_order_regression_or_missing_snapshot')
        if snapshot: self.bids={};self.asks={};self.wall=None
        for field,target in [('b',self.bids),('a',self.asks)]:
            for price,size in d[field]:
                if Decimal(price)<=0 or Decimal(size)<0: raise ValueError('invalid_book_level')
                if Decimal(size)==0: target.pop(price,None)
                else: target[price]=size
        self.u=u;self.seq=seq;self.receipt_ms=receipt_ms;self.exchange_ms=int(msg.get('cts',msg['ts']))
        self.valid=bool(self.bids and self.asks)
        if self.valid and max(map(Decimal,self.bids))>=min(map(Decimal,self.asks)):
            self.valid=False;raise ValueError('crossed_book')
        # Neither u nor seq is documented as contiguous at this subscribed depth.
        # Do not fabricate a gap from seq+1. Transport loss/regression forces resubscription.

    def summary(self,at):
        if not self.valid or at-self.receipt_ms>10000: return {'book_available':False,'gap_or_stale':True}
        bids=sorted(self.bids.items(),key=lambda x:Decimal(x[0]),reverse=True)[:50]
        asks=sorted(self.asks.items(),key=lambda x:Decimal(x[0]))[:50]
        bb=Decimal(bids[0][0]);ba=Decimal(asks[0][0]);mid=(bb+ba)/2
        result={'book_available':True,'gap_or_stale':False,'bid_levels':bids,'ask_levels':asks,
                'best_bid':str(bb),'best_ask':str(ba),'spread':str(ba-bb),'spread_bps':float((ba-bb)/mid*10000),
                'update_id':self.u,'sequence':self.seq,'source_receipt_ms':self.receipt_ms,'exchange_ms':self.exchange_ms,
                'depth_truncated':True,'rpi_excluded':True}
        b0=Decimal(bids[0][1]);a0=Decimal(asks[0][1]);result['bid_ask_imbalance']=float((b0-a0)/(b0+a0))
        for band in [5,10,25]:
            b=sum((Decimal(sz) for p,sz in bids if Decimal(p)>=mid*(1-Decimal(band)/10000)),Decimal(0))
            a=sum((Decimal(sz) for p,sz in asks if Decimal(p)<=mid*(1+Decimal(band)/10000)),Decimal(0))
            result[f'bid_depth_{band}bps']=str(b);result[f'ask_depth_{band}bps']=str(a)
            result[f'depth_imbalance_{band}bps']=float((b-a)/(b+a)) if b+a else None
        wall=max([('bid',p,sz) for p,sz in bids]+[('ask',p,sz) for p,sz in asks],key=lambda x:Decimal(x[2]))
        if wall[:2]!=self.wall: self.wall=wall[:2];self.wall_since=at
        result['largest_displayed_wall']=wall;result['sampled_wall_age_ms']=at-self.wall_since
        depth=sum((Decimal(sz) for _,sz in bids+asks),Decimal(0))
        result['sampled_depth_change']=str(depth-self.previous_depth) if self.previous_depth is not None else None
        self.previous_depth=depth;return result

class Flow:
    def __init__(self,symbols):
        self.books={s:Book() for s in symbols}; self.trades={s:deque() for s in symbols}
        self.ids={s:set() for s in symbols};self.id_order={s:deque() for s in symbols}
        self.cvd={s:Decimal(0) for s in symbols};self.epoch=uuid.uuid4().hex
        self.epoch_start_ms=None;self.last_trade={s:0 for s in symbols};self.last_seq={s:None for s in symbols}
        self.unknown_side=0;self.duplicates=0;self.regressions=0

    def reconnect(self,at):
        self.epoch=uuid.uuid4().hex;self.epoch_start_ms=at
        for s in self.books:
            self.books[s]=Book();self.cvd[s]=Decimal(0);self.trades[s].clear();self.last_seq[s]=None

    def trade(self,d,at):
        s=d['s'];p=Decimal(d['p']);size=Decimal(d['v']);trade_id=d['i'];side=d['S']
        if p<=0 or size<=0 or side not in ['Buy','Sell']: raise ValueError('invalid_public_trade')
        if trade_id in self.ids[s]: self.duplicates+=1;return False
        self.ids[s].add(trade_id);self.id_order[s].append(trade_id)
        if len(self.id_order[s])>200000:self.ids[s].remove(self.id_order[s].popleft())
        seq=d.get('seq')
        if seq is not None and self.last_seq[s] is not None and seq<self.last_seq[s]:
            self.regressions+=1;raise ValueError('trade_sequence_regression')
        if seq is not None:self.last_seq[s]=seq
        signed=size if side=='Buy' else -size;self.cvd[s]+=signed;self.last_trade[s]=at
        self.trades[s].append((at,int(d['T']),p,size,side))
        while self.trades[s] and self.trades[s][0][0]<at-61000:self.trades[s].popleft()
        return True

    def rollup(self,s,at,seconds,book):
        rows=[r for r in self.trades[s] if at-seconds*1000<=r[0]<at]
        buy=sum((r[3] for r in rows if r[4]=='Buy'),Decimal(0));sell=sum((r[3] for r in rows if r[4]=='Sell'),Decimal(0))
        change=float(abs(rows[-1][2]/rows[0][2]-1)*10000) if len(rows)>1 else None
        # A declared price/flow ratio, not evidence of hidden liquidity.
        absorption=float(buy+sell)/max(change,0.1) if change is not None else None
        fresh=at-self.last_trade[s]<30000
        return {'symbol':s,'namespace':'of_v1','window_seconds':seconds,'window_start_ms':at-seconds*1000,'window_end_ms':at,
                'clock':'receipt','taker_buy_volume':str(buy),'taker_sell_volume':str(sell),'delta':str(buy-sell),
                'session_cvd':str(self.cvd[s]),'rolling_cvd_delta':str(buy-sell),'cvd_anchor_id':self.epoch,'cvd_anchor_ms':self.epoch_start_ms,
                'window_within_connection':self.epoch_start_ms is not None and at-seconds*1000>=self.epoch_start_ms,
                'stream_fresh':fresh,'continuity':'transport_observed_exchange_completeness_unproven',
                'max_exchange_ms':max((r[1] for r in rows),default=None),'max_receipt_ms':max((r[0] for r in rows),default=None),
                'trade_count':len(rows),'absorption_volume_per_bps':absorption,'price_move_bps':change,
                **{k:v for k,v in book.items() if k not in ['bid_levels','ask_levels']}}
