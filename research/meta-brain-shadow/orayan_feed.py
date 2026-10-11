"""Read-only consumer of the EXISTING canonical export. No Orayan writes.

The transport is a compact research ZIP, not raw market data. Only explicitly
selected episode fields survive intake; requests/raw provider responses/config
contents are referenced by their canonical immutable IDs and original hashes.
"""
import base64,hashlib,io,json,zipfile
from decision_store import digest

URL='https://p01--min-service--2c624d5p4kgs.code.run/api/capture/current.zip'
FIELDS=('eventId','episodeId','sourceEpisodeId','candidateId','tradeId','controlTradeId','sequence','epochId',
    'at','receivedAt','persistedAt','symbol','side','strategy','strategyVersion','mode','configHash','writerDefinitionId',
    'boundary','admission','rejectReason','score','regime','context','features','geometry','gateChecks','failedGates','decisionReference',
    'inheritedWorkingState','excursion','intrabarOrder','includesPossiblePreFillExtremes','terminalMinuteMayIncludePostExitExtremes',
    'quality','directionPermission','closedBarOpenAt','capturedAt','initialEntry','lastObservedBarAt','coverageComplete','censored',
    'researchOnly','executionAllowed','hypothetical','outputType','captureCohort','holdoutCohort',
    'transitions','status','outcome','reasonCode','reasonHash','reason','closeReason','outcomeComplete','completeness','censorReason',
    'plannedEntry','initialStop','initialTarget','sl','tp','fillPrice','entryPrice','filledAt','closedAt','exitPrice',
    'grossPnl','fees','fundingCost','fundingStatus','netPnlBeforeFunding','netPnl','realizedR','realisedRR',
    'mfePerUnit','maePerUnit','mfeR','maeR','excursionPrecision','ambiguityCount','holdMs','fillEconomics',
    'provider','evaluationId','attemptId','event','disposition','authority','result','parsed','normalized','failureEvidence',
    'policy','armId','version','definitionVersion','eligible','complete','fillStatus','endpoint','netR','opportunityNetCash',
    'admissionOrdinal','repeatEligible','decisionGeometryRejected','fillGeometryRejected','matchedFillSubset','equalRiskUsdt')

def normalize(row,original_hash):
    stream=row.get('stream')
    if stream not in ('decisions','lifecycle','outcomes','experiments','ai_calls'):return None
    out={k:row[k] for k in FIELDS if k in row}
    out['_original_source_sha256']=original_hash;out['_source_stream']=stream
    out['capturedAt']=row.get('persistedAt',row.get('receivedAt',row.get('at')))
    out['btcRegime']=row.get('regime',row.get('context',{}).get('regime'))
    out['engine']=row.get('strategy','OTHER')
    if stream=='decisions':
        out['kind']='candidate_birth' if row.get('boundary')=='candidate_birth' else 'candidate_update'
        geometry=row.get('geometry') or {}
        out.update(plannedEntry=geometry.get('entryPrice'),plannedSl=geometry.get('invalidationPrice'),plannedTp=geometry.get('objectivePrice'))
    elif stream in ('lifecycle','outcomes'):
        out['kind']='order_outcome'
        transitions=row.get('transitions') or []
        last=transitions[-1] if transitions else None
        if isinstance(last,dict):last=last.get('status',last.get('to',last.get('event')))
        out['event']=row.get('status') if row.get('outcomeComplete') else (last or row.get('event',row.get('status')))
        out['realisedRR']=row.get('realisedRR',row.get('realizedR'))
    elif stream=='experiments':
        out['kind']='experiment_outcome' if row.get('complete') or (row.get('endpoint') or {}).get('outcomeComplete') else 'experiment_observation'
        endpoint=row.get('endpoint') or {};out['realisedRR']=row.get('netR',endpoint.get('realizedR',endpoint.get('realisedRR')))
        out['closedAt']=endpoint.get('closedAt',row.get('at'))
    else:
        out['kind']='orayan_advisory'
        ledger=row.get('ledgerRecord') or {}
        out['advisory']={k:ledger[k] for k in ('status','decision','model','request_id','prompt_version','prompt_hash',
            'response_schema_hash','input_snapshot_hash','available_to_system_at_utc','completed_at_utc') if k in ledger}
        if len(json.dumps(out['advisory']))>8192:
            out['advisory']={'status':'REFERENCED_NOT_COPIED','source_event_id':row['eventId'],'source_checksum':original_hash}
        # Never copy raw prompts, provider requests, token ledgers or full text.
        for key in ('result','parsed','normalized'):
            if row.get('event')=='RAW_RESPONSE':out.pop(key,None)
            if key in out and len(json.dumps(out[key]))>16384:
                out[key]={'status':'REFERENCED_NOT_COPIED','source_event_id':row.get('eventId'),'source_checksum':original_hash}
    return out

def selected_events(file):
    """Validate transport manifest and reconstruct one bounded source event at a time."""
    with zipfile.ZipFile(file) as z:
        if z.testzip() is not None:raise ValueError('Orayan ZIP CRC failure')
        manifest=json.loads(z.read('manifest.json'))
        if manifest.get('schemaVersion')!='ORAYAN_RESEARCH_V2' or not manifest.get('complete'):raise ValueError('Unsupported/incomplete canonical export')
        specs={v['name']:v for v in manifest['entries']}
        metadata={v['eventId']:v for v in manifest['events']}
        result=[];seen=set();projected_bytes=0
        for name in sorted(z.namelist()):
            if name not in ('records/decisions.jsonl','records/lifecycle.jsonl','records/outcomes.jsonl','records/experiments.jsonl','records/ai_calls.jsonl'):continue
            expected=specs.get(name)
            if not expected:raise ValueError('Missing canonical entry manifest')
            h=hashlib.sha256();size=0;parts={};pending_bytes=0
            with z.open(name) as f:
                for line in f:
                    h.update(line);size+=len(line)
                    piece=json.loads(line);meta=piece['meta'];key=meta['eventId'];index=piece['index']
                    if meta!=metadata.get(key):raise ValueError('Source metadata mismatch')
                    blob=base64.b64decode(piece['data'],validate=True)
                    if not 0<=index<meta['chunks'] or meta['bytes']>1024*1024:raise ValueError('Canonical event size/part bound')
                    chunks=parts.setdefault(key,{})
                    if index in chunks:raise ValueError('Duplicate canonical part')
                    chunks[index]=blob;pending_bytes+=len(blob)
                    if pending_bytes>4*1024*1024:raise ValueError('Canonical reconstruction memory bound')
                    if len(chunks)==meta['chunks']:
                        data=b''.join(chunks[i] for i in range(meta['chunks']));pending_bytes-=len(data);del parts[key]
                        if len(data)!=meta['bytes'] or hashlib.sha256(data).hexdigest()!=meta['sha256']:raise ValueError('Canonical source hash mismatch')
                        source=json.loads(data)
                        if source['eventId']!=key or key in seen:raise ValueError('Canonical event identity mismatch')
                        seen.add(key);normalized=normalize(source,meta['sha256'])
                        if normalized:
                            projected_bytes+=len(json.dumps(normalized).encode())
                            if projected_bytes>32*1024*1024:raise ValueError('Canonical projection memory bound')
                            result.append(normalized)
            if parts or h.hexdigest()!=expected['sha256'] or size!=expected['bytes']:raise ValueError('Incomplete/corrupt canonical entry')
        wanted={m['eventId'] for m in manifest['events'] if m['stream'] in ('decisions','lifecycle','outcomes','experiments','ai_calls')}
        if seen!=wanted:raise ValueError('Canonical selection completeness mismatch')
        if len(result)>25000:raise ValueError('Canonical population bound')
        return manifest,sorted(result,key=lambda r:r['sequence'])

def ingest_export(store,consumer,file,observed_ms,validated=None,clock=None):
    manifest,events=validated if validated is not None else selected_events(file)
    epochs={r['epochId'] for r in events}
    if len(epochs)>1:raise ValueError('Mixed canonical epoch')
    epoch=next(iter(epochs),None);checkpoint=store.state('orayan_cursor') or {}
    last=checkpoint.get('sequence',0) if checkpoint.get('epoch')==epoch else 0
    integrity=manifest.get('integrity') or {}
    reference={'url':URL,'watermark_sha256':digest(manifest['watermark']),'source_epoch':epoch,
               'export_integrity_sha256':digest(integrity),'population_complete':integrity.get('populationComplete'),
               'immutable_source_hashes_verified':True}
    key='orayan-export:'+str(epoch)+':'+str(manifest['watermark'])
    if not store.get_event(key):
        with store.transaction():store.add('integrity',key,None,observed_ms,observed_ms,
            {'kind':'ORAYAN_CANONICAL_EXPORT_WATERMARK','source_reference':reference,'selected_events':len(events),
             'critical_loss':integrity.get('criticalLoss'),'optional_suppression':integrity.get('optionalSuppression'),
             'reconciliation':integrity.get('reconciliation'),'no_production_mutation':True})
    terminal_episodes={r.get('episodeId') for r in events if r['kind']=='experiment_outcome' or
                       (r['kind']=='order_outcome' and (r.get('outcomeComplete') or r.get('event') in
                        ('CLOSED','CANCELLED','CANCELED','EXPIRED','NO_ORDER','NO_FILL','REJECTED','CENSORED')))}
    new=[r for r in events if r['sequence']>last]
    for offset in range(0,len(new),64):
        with store.transaction():
            for source in new[offset:offset+64]:
                # Decision formation uses its actual clock, never the start of a
                # potentially long batch. This matters for pre-outcome validity.
                current=clock() if clock else observed_ms
                consumer.ingest(source,current,reference,resolved_before_observation=source.get('episodeId') in terminal_episodes)
                store.set_state('orayan_cursor',{'epoch':epoch,'sequence':source['sequence'],'watermark':manifest['watermark'],'observed_ms':current})
    return {'source_epoch':epoch,'watermark':manifest['watermark'],'selected_events':len(events),
            'intake':'READ_ONLY_CANONICAL_EXPORT','source_population_complete':(manifest.get('integrity') or {}).get('populationComplete')}
