"""Registered experimental baseline; no trading logic or calibrated probabilities."""
import math
from decision_store import digest
VERSION='confirmed-structure-direction-0.1'
DEFINITION={'id':VERSION,'status':'EXPERIMENTAL_UNVALIDATED','execution_enabled':False,
    'rule':'latest confirmed BOS continuation or SWEEP reversal direction within 120 minutes; conflicting simultaneous directions abstain',
    'inputs':'independent public completed OHLC and frozen confirmed-pivot detector only',
    'geometry':'reference latest completed close; 1 current ATR15 stop and 2 ATR15 objective',
    'endpoint':'60 completed minutes starting next minute; minute-level ambiguity censored',
    'confidence':'uncalibrated; probability is null','weights_changed':False}

def context_from_base(base,symbol,at):
    from frozen_detector import aggregate,detect
    from frozen_features import Minutes
    from storage import clean
    m=base.frames(symbol);b=aggregate(m)
    if len(b)<200:return {'status':'WARMUP','events':[]}
    e=detect(b,symbol)
    if e.empty:return {'status':'NO_CONFIRMED_STRUCTURE','events':[]}
    e=e[e.eventType.isin(['BOS','SWEEP']) & (e.knownAt<=at) & (e.knownAt>=at-120*60000)]
    if e.empty:return {'status':'NO_RECENT_CONFIRMED_STRUCTURE','events':[]}
    e=e[e.knownAt==e.knownAt.max()]
    fields=('event_id','eventType','direction','knownAt','level_id','level','level_knownAt','level_pivotAt')
    return clean({'status':'AVAILABLE','events':e[list(fields)].to_dict('records'),'reference_close':float(m.close.iloc[-1]),
        'reference_minute_ms':int(m.timestamp_ms.iloc[-1]),'max_input_receipt_ms':int(m.receipt_ms.max()),
        'atr15':float(Minutes(m,b).atr[-1]),'computed_ms':at})

def decide_structure(context,at,fresh):
    result={'action':'ABSTAIN','confidence':None,'confidence_status':'UNCALIBRATED_EXPERIMENT',
        'policy_version':VERSION,'experiment_id':VERSION,'experimental':True,
        'reasons':[],'structural_snapshot':context,'structural_snapshot_hash':digest(context)}
    if not fresh:result['abstention_reason']='MISSING_OR_STALE_INDEPENDENT_INPUTS';return result
    events=context.get('events',[])
    if not events:result['abstention_reason']=context.get('status','NO_CONFIRMED_STRUCTURE');return result
    if context.get('max_input_receipt_ms',at+1)>at or any(not isinstance(e.get('knownAt'),(int,float)) or
        not 0<=at-e['knownAt']<=120*60000 or e.get('level_knownAt',at+1)>at for e in events):
        result['abstention_reason']='INVALID_STRUCTURE_AVAILABILITY';return result
    directions={e['direction'] for e in events}
    if len(directions)!=1 or next(iter(directions)) not in (1,-1):
        result['abstention_reason']='CONFLICTING_CONFIRMED_STRUCTURE';return result
    entry=context.get('reference_close');atr=context.get('atr15')
    if not all(isinstance(v,(int,float)) and math.isfinite(v) and v>0 for v in (entry,atr)):
        result['abstention_reason']='INVALID_REFERENCE_GEOMETRY';return result
    direction=next(iter(directions));stop=entry-direction*atr;target=entry+direction*2*atr
    if min(stop,target)<=0:result['abstention_reason']='INVALID_REFERENCE_GEOMETRY';return result
    result.update(action='LONG' if direction==1 else 'SHORT',
        abstention_reason=None,
        reasons=[{'code':'CONFIRMED_'+e['eventType'],'independent_event_id':e['event_id'],'known_at_ms':e['knownAt']} for e in events],
        reference_geometry={'entry':entry,'stop':stop,'target':target,'risk':atr,'hypothetical':True},
        label_start_ms=(at//60000+1)*60000,label_horizon_minutes=60)
    return result

def mature_structure(decision,minutes,at):
    start=decision['label_start_ms'];end=start+60*60000
    if at<end:return None
    path=[minutes.get(t) for t in range(start,end,60000)]
    if any(p is None or p.get('cohort')!='prospective' or p['receipt_ms']>at for p in path):
        return {'status':'CENSORED_INPUT_GAP_OR_RESTART','resolved_ms':end,'observed_ms':at,'confidence':None}
    g=decision['reference_geometry'];d=1 if decision['action']=='LONG' else -1
    high=max(p['high'] for p in path);low=min(p['low'] for p in path)
    mfe=(high-g['entry'])/g['risk'] if d==1 else (g['entry']-low)/g['risk']
    mae=(g['entry']-low)/g['risk'] if d==1 else (high-g['entry'])/g['risk']
    endpoint='HORIZON';r=d*(path[-1]['close']-g['entry'])/g['risk'];exit_ms=end;gap=None
    for p in path:
        target=p['high']>=g['target'] if d==1 else p['low']<=g['target']
        stop=p['low']<=g['stop'] if d==1 else p['high']>=g['stop']
        if target and stop:endpoint='AMBIGUOUS_BOTH_SAME_MINUTE';r=None;exit_ms=p['timestamp_ms']+60000;break
        if target or stop:
            endpoint='TARGET' if target else 'STOP';r=2. if target else -1.;exit_ms=p['timestamp_ms']+60000
            if stop and d*(p['open']-g['stop'])<0:
                gap={'bar_open':p['open'],'planned_stop':g['stop'],'bar_ms':p['timestamp_ms'],'receipt_ms':p['receipt_ms']}
                r=d*(p['open']-g['entry'])/g['risk']
            break
    return {'status':'MATURED_COUNTERFACTUAL','endpoint':endpoint,'realizedR':r,'resolved_ms':exit_ms,'observed_ms':at,
        'mfeR_full_horizon':mfe,'maeR_full_horizon':mae,'reference_geometry':g,'terminal_close':path[-1]['close'],
        'path_summary':{'minute_count':60,'high':high,'low':low,'max_receipt_ms':max(p['receipt_ms'] for p in path)},
        'hypothetical':True,'costs':'excluded; no executed P&L claim','intrabar_precision':'minute OHLC; both-touch censored',
        'loss_reason':([{'category':'adverse_gap_slippage','confidence':0.6,'evidence':gap,
                        'causal_certainty':'observed opening gap; execution remains hypothetical'}] if gap else
                      [{'category':'unknown_ambiguous','confidence':0.,'evidence':{'endpoint':endpoint}}]) if r is not None and r<0 else []}
