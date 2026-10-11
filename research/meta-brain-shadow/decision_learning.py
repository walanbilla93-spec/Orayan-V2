"""Causal joins and conservative failure attribution; never modifies model weights."""
from decision_store import digest,day

LOSS_CATEGORIES=frozenset(('bad_direction_regime_misread','entry_timing','stop_geometry',
    'adverse_gap_slippage','regime_change','liquidity_volatility_shock','stale_missing_inputs',
    'model_disagreement','execution_cost_funding','unknown_ambiguous'))
CANDIDATES=frozenset(('candidate_birth','candidate_update','suppressed_candidate','signal_suppressed','candidate_rejected'))
OUTCOMES=frozenset(('order_outcome','forward_label','order_flow_label','experiment_outcome','no_fill','cancel'))
TERMINAL=frozenset(('CLOSED','CANCELLED','CANCELED','NO_FILL','REJECTED','EXPIRED','CENSORED'))

def loss_attribution(outcome,decision,now):
    r=outcome.get('realisedRR',outcome.get('realizedR'))
    pnl=outcome.get('netPnl')
    loss=(isinstance(r,(int,float)) and r<0) or (isinstance(pnl,(int,float)) and pnl<0) or outcome.get('plannedTpSlOutcome') in ('SL_FIRST','BOTH_SAME_MINUTE_STOP_FIRST')
    if not loss:return None
    reasons=[];cutoff=min(now,outcome.get('capturedAt',now))
    # Accept explicit source diagnostic facts only if their observation clock is
    # present and no later than this outcome evaluation. No guessed causal labels.
    for fact in outcome.get('failureEvidence',[]):
        if not isinstance(fact,dict):continue
        category=fact.get('category');at=fact.get('observedAt')
        if category not in LOSS_CATEGORIES or not isinstance(at,(int,float)) or at>cutoff or not fact.get('evidence'):continue
        confidence=fact.get('confidence',0.25)
        if not isinstance(confidence,(int,float)):confidence=0.25
        reasons.append({'category':category,'confidence':max(0.,min(0.8,confidence)),
                        'evidence':fact['evidence'],'source_observed_ms':at,'causal_certainty':'contributing_hypothesis'})
    gross=outcome.get('grossPnl');fees=outcome.get('fees');funding=outcome.get('fundingCost')
    if all(isinstance(v,(int,float)) for v in (gross,pnl)) and gross>0 and pnl<0 and (
        isinstance(fees,(int,float)) and fees>0 or isinstance(funding,(int,float)) and funding>0):
        reasons.append({'category':'execution_cost_funding','confidence':0.75,'source_observed_ms':cutoff,
            'evidence':{'gross_pnl':gross,'net_pnl':pnl,'fees':fees,'funding_cost':funding},
            'causal_certainty':'recorded positive gross versus negative net; contributing cost effect'})
    if not reasons or outcome.get('sameMinuteAmbiguity') or outcome.get('entryTouchBarAmbiguous'):
        reasons.append({'category':'unknown_ambiguous','confidence':0.,
                        'evidence':{'endpoint':outcome.get('event',outcome.get('plannedTpSlOutcome')),'source_reason':outcome.get('reason'),
                                    'same_minute_ambiguity':outcome.get('sameMinuteAmbiguity'),
                                    'decision_input_gaps':decision.get('input_integrity') if decision else None},
                        'causal_certainty':'insufficient_evidence'})
    return {'loss_reason':reasons,'evaluated_at_ms':now,'multiple_contributors_supported':True,
            'policy':'SOURCE_DIAGNOSTICS_WITH_CLOCKS_ONLY; terminal stop/loss alone does not establish its cause'}

def comparison(decision,signal):
    if not decision:return {'state':'orayan-only','reason':'No contemporaneous independent decision'}
    action=decision.get('action');orayan=signal.get('side');orayan={'BUY':'LONG','SELL':'SHORT'}.get(orayan,orayan)
    if action in ('LONG','SHORT') and orayan in ('LONG','SHORT'):
        return {'state':'agree' if action==orayan else 'disagree','directional_comparison_available':True}
    return {'state':'independent-abstention','directional_comparison_available':False,
            'reason':decision.get('abstention_reason','Directional policy unavailable'),
            'independent_activity_view':decision.get('frozen_estimates')}

def bucket(signal,cmp):
    # Bound vocabulary/cardinality: do not create a new bucket per symbol/episode.
    regime=str(signal.get('btcRegime','unknown')).upper()
    if regime not in ('TREND_UP','TREND_DOWN','TREND','RANGE','SIDEWAYS','CHOP','SHOCK','TRANSITION','BULL','BEAR',
                      'BULL_RANGE','BEAR_RANGE','BULL_TREND','BEAR_TREND'):regime='OTHER_OR_UNKNOWN'
    family=str(signal.get('engine','unknown')).upper()
    if family not in ('NEW_ORAYAN','MARCI','V3','ORAYAN_V3'):family='OTHER'
    return '|'.join((regime,family,cmp.get('state','orayan-only')))

class EpisodeConsumer:
    def __init__(self,store,decide):self.store=store;self.decide=decide
    def ingest(self,source,observed_ms,source_reference,resolved_before_observation=False):
        kind=source.get('kind');episode=source.get('episodeId');source_id=source.get('eventId')
        if not episode or not source_id:
            # A missing canonical episode identity must never be guessed from symbol/side.
            key='gap:'+digest({'reference':source_reference,'source_hash':digest(source)})
            self.store.add('integrity',key,None,observed_ms,observed_ms,{'kind':'ORAYAN_SOURCE_IDENTITY_MISSING','source_hash':digest(source),'source_reference':source_reference})
            return
        if kind not in CANDIDATES|OUTCOMES|{'orayan_advisory','experiment_observation'}:return
        # Received source events may be replayed; canonical IDs deduplicate before any decision.
        event_id='orayan:'+source_id
        prior=self.store.get_event(event_id)
        if prior:
            if prior.get('source_sha256')!=digest(source):raise ValueError('Canonical Orayan ID changed content')
            return
        at=source.get('capturedAt',source.get('at',observed_ms))
        if not isinstance(at,(int,float)) or at>observed_ms:raise ValueError('Future or invalid source clock')
        receipt={'source':'Orayan canonical compact feed','source_event_id':source_id,'episode_id':episode,
                 'source_sha256':digest(source),'source_reference':source_reference,'observed_ms':observed_ms}
        receipt['original_source_sha256']=source.get('_original_source_sha256')
        if kind in ('orayan_advisory','experiment_observation'):
            self.store.add('orayan_signal_observed',event_id,episode,at,observed_ms,
                {**receipt,'observation':source,'comparison_input_only':True,'source_refs':[{'event_id':source_id,'source':'Orayan'}]})
            return
        if kind in CANDIDATES:
            # Crucially the independent callback receives only symbol and cutoff,
            # never Orayan side/score/gates/advisories or any outcome.
            pending=self.store.pending(episode)
            already_resolved=bool(pending and pending.get('resolved'))
            decision=None if already_resolved or resolved_before_observation or observed_ms-at>90000 else self.decide(source.get('symbol'),observed_ms)
            cmp=comparison(decision,source);key=bucket(source,cmp)
            summary={family:self.store.trust(family+'|'+key,observed_ms) for family in
                     ('EXECUTED_PAPER','EXECUTED_LIVE','ORAYAN_COUNTERFACTUAL','FORWARD_COUNTERFACTUAL','STRUCTURAL_BASELINE','EXPERIMENT')}
            summary={family:value for family,value in summary.items() if value.get('count',0)>0}
            self.store.add('orayan_signal_observed',event_id,episode,at,observed_ms,
                {**receipt,'signal':source,'source_refs':[{'event_id':source_id,'source':'Orayan',
                    'checksum':receipt['original_source_sha256'] or receipt['source_sha256'],
                    'checksum_kind':'original_canonical_event' if receipt['original_source_sha256'] else 'normalized_projection'}]})
            if decision:
                if decision.get('decision_ms')!=observed_ms or decision.get('max_input_receipt_ms',observed_ms)>observed_ms:raise ValueError('Decision availability violation')
                decision={**decision,'performance_summary_snapshot':summary,'performance_summary_versions':{k:v.get('version') for k,v in summary.items()},
                          'performance_summaries_used_by_model':False,
                          'orayan_inputs_used':False,'original_snapshot_immutable':True,'source_refs':[{'event_id':event_id,'role':'comparison_only_not_model_input'}]}
                self.store.add('meta_decision','decision:'+source_id,episode,observed_ms,observed_ms,decision)
                if decision.get('experimental') and decision.get('action') in ('LONG','SHORT'):
                    self.store.set_pending('baseline:'+source_id,{'decision':decision,'decision_id':'decision:'+source_id,
                        'symbol':source.get('symbol'),'observed_ms':observed_ms,'bucket':key})
            self.store.add('decision_comparison','comparison:'+source_id,episode,observed_ms,observed_ms,
                {**cmp,'decision_id':'decision:'+source_id if decision else None,'orayan_event_id':event_id,'bucket':key,
                 'source_refs':[{'event_id':event_id},{'event_id':'decision:'+source_id}] if decision else [{'event_id':event_id}]})
            if not already_resolved:
                version={'signal':source,'decision':decision,'comparison':cmp,'bucket':key,
                    'source_receipt':receipt,'candidate_event_id':event_id,'decision_id':'decision:'+source_id if decision else None,'observed_ms':observed_ms,'resolved':False}
                version_key=source_id
                if pending is None:pending={**version,'birth_version':version_key,'versions':{}}
                versions=pending.setdefault('versions',{})
                versions[version_key]=version
                # Keep the birth plus recent material versions. Evicted versions
                # remain in daily canonical archives; later unjoinable endpoints
                # are explicitly censored instead of borrowing another decision.
                while len(versions)>8:
                    oldest=next(k for k in versions if k!=pending['birth_version']);del versions[oldest]
                self.store.set_pending(episode,pending)
            return
        episode_state=self.store.pending(episode)
        versions=episode_state.get('versions',{}) if episode_state else {}
        candidate=source.get('candidateId')
        reference=source.get('decisionReference')
        active=episode_state.get('active_trade_versions',{}) if episode_state else {}
        if isinstance(reference,str):
            pending=next((v for v in versions.values() if v['source_receipt']['source_event_id']==reference),None)
            if pending is None:pending=next((v for v in active.values() if v['source_receipt']['source_event_id']==reference),None)
            if pending is None:
                original=self.store.get_event('orayan:'+reference);cmp=self.store.get_event('comparison:'+reference)
                if original and original.get('episode_id')==episode and original.get('signal') and cmp:
                    pending={'signal':original['signal'],'decision':self.store.get_event('decision:'+reference),
                        'comparison':cmp,'bucket':cmp['bucket'],'source_receipt':original,'candidate_event_id':'orayan:'+reference,
                        'decision_id':cmp.get('decision_id'),'observed_ms':original['observed_ms']}
        elif reference is not None:pending=None
        elif source.get('tradeId') in active:pending=active[source['tradeId']]
        elif kind=='forward_label' and episode_state:pending=versions.get(episode_state.get('birth_version'))
        elif candidate is not None:
            matches=[v for v in versions.values() if v['signal'].get('candidateId')==candidate]
            pending=matches[0] if len(matches)==1 else None
        elif len(versions)==1:pending=next(iter(versions.values()))
        else:pending=None
        decision=pending.get('decision') if pending else None
        resolved=source.get('closedAt') or source.get('plannedTpSlResolvedAt') or source.get('at',observed_ms)
        terminal=kind=='forward_label' or source.get('event') in TERMINAL or kind in ('no_fill','cancel','experiment_outcome')
        if not isinstance(resolved,(int,float)) or resolved>observed_ms:raise ValueError('Future/invalid resolution')
        if pending and episode_state and not terminal and source.get('tradeId') and source.get('event') in ('OPEN','PENDING','FILLED'):
            active[source['tradeId']]=pending
            if len(active)>8:raise RuntimeError('ACTIVE_TRADE_JOIN_SIZE_PRESSURE')
            episode_state['active_trade_versions']=active;self.store.set_pending(episode,episode_state)
        causal=bool(decision and decision['decision_ms']<resolved)
        record={**receipt,'outcome':source,'terminal':terminal,'resolved_ms':resolved,
                'decision_id':pending.get('decision_id') if pending else None,'independent_comparison_valid':causal,
                'join_status':'MATCHED_PRE_OUTCOME' if causal else 'ORAYAN_ONLY_OR_LATE_DECISION',
                'decision_snapshot':decision,'candidate_snapshot':pending.get('signal') if pending else None,
                'comparison':pending.get('comparison') if pending else comparison(None,source),
                'source_refs':[{'event_id':pending['candidate_event_id'],'owner_date':day(pending['observed_ms']),
                                'checksum':pending['source_receipt']['source_sha256']}] if pending else [],
                'gaps_censors':[] if pending else ['CANONICAL_BIRTH_NOT_OBSERVED']}
        self.store.add('lifecycle_outcome',event_id,episode,at,observed_ms,record)
        if terminal:
            loss=loss_attribution(source,decision,observed_ms)
            if loss:self.store.add('loss_attribution','loss:'+source_id,episode,resolved,observed_ms,{**loss,'outcome_id':event_id,'source_refs':[{'event_id':event_id}]})
            r=source.get('realisedRR',source.get('realizedR'))
            if r is None and kind=='forward_label' and pending and not source.get('sameMinuteAmbiguity') and not source.get('entryTouchBarAmbiguous'):
                # Price-cross counterfactuals are a different family from executed P&L.
                r=-1. if source.get('plannedTpSlOutcome')=='SL_FIRST' else None
                if source.get('plannedTpSlOutcome')=='TP_FIRST':
                    p=pending['signal'];entry=p.get('plannedEntry');sl=p.get('plannedSl');tp=p.get('plannedTp')
                    if all(isinstance(v,(int,float)) for v in (entry,sl,tp)) and entry!=sl:r=abs(tp-entry)/abs(entry-sl)
            if pending:
                if kind=='experiment_outcome':family='EXPERIMENT'
                elif source.get('hypothetical') or source.get('executionAllowed') is False:family='ORAYAN_COUNTERFACTUAL'
                elif source.get('event')=='CLOSED':family='EXECUTED_LIVE' if str(source.get('mode','')).upper()=='LIVE' else 'EXECUTED_PAPER'
                else:family='FORWARD_COUNTERFACTUAL'
                learning_key=family+'|'+(pending['bucket'] if causal else 'ORAYAN_ONLY_LATE|'+pending['bucket'].rsplit('|',1)[0])
                arm=str(source.get('policy') or source.get('armId') or source.get('version') or '') if kind=='experiment_outcome' else ''
                self.store.learn(family+'|'+episode+'|'+str(source.get('tradeId') or '')+'|'+arm,learning_key,resolved,observed_ms,r)
                lesson={'outcome_id':event_id,'bucket':learning_key,'valid_independent_comparison':causal,
                        'trust_statistics_only':True,'weights_changed':False,'source_refs':[{'event_id':event_id}]}
                self.store.add('lesson','lesson:'+source_id,episode,resolved,observed_ms,lesson)
                if episode_state and kind!='experiment_outcome':
                    episode_state['resolved']=True;episode_state['resolved_ms']=resolved;self.store.set_pending(episode,episode_state)
