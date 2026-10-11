"""Explicit source-only deployment amendment; never clears research records."""
import re,time
from decision_store import digest
ALLOWED=frozenset(('decision_launcher.py','decision_runtime.py','orayan_feed.py'))

def validate(receipt,spec):
    if spec['service']!='meta-brain-shadow-v1' or spec['epoch']!=receipt['boot']['epoch_id']:
        raise RuntimeError('Deployment amendment scope/epoch mismatch')
    if spec['previous_reset_receipt_sha256']!=receipt['receipt_sha256']:
        raise RuntimeError('Deployment amendment reset provenance mismatch')
    if spec['execution_enabled'] is not False or spec['research_rows_deleted']!=0:
        raise RuntimeError('Destructive/execution amendment prohibited')
    old=receipt['boot']['build_files_sha256'];new=spec['files']
    if not set(old)<=set(new):raise RuntimeError('Sealed source omitted')
    changed={name for name,h in old.items() if new[name]!=h}
    if not changed<=ALLOWED or set(new)-set(old)!={'deployment_amendment.py'}:
        raise RuntimeError('Model/config/unrelated source change prohibited')
    return digest(spec)

def apply(store,receipt,spec,source_commit):
    amendment_id=validate(receipt,spec)
    if not re.fullmatch('[0-9a-f]{40}',source_commit or ''):raise RuntimeError('Verified image source commit required')
    existing=store.state('deployment_amendment')
    if existing:
        if existing['amendment_id']!=amendment_id or existing['new_source_commit']!=source_commit:
            raise RuntimeError('Unexpected deployment amendment chain')
        return existing
    at=int(time.time()*1000)
    before=store.status()
    record={'amendment_id':amendment_id,'spec':spec,'new_source_commit':source_commit,
        'previous_lineage_sha256':digest(store.state('lineage')),'applied_at_ms':at,
        'canonical_events_preserved':before['events'],'research_rows_deleted':0,
        'previous_reset_receipt_sha256':receipt['receipt_sha256'],'model_config_unchanged':True,'execution_enabled':False}
    with store.transaction():
        store.set_state('deployment_amendment',record)
        store.set_state('capture_pause',{'reason':'DEPLOYMENT_AMENDMENT_AWAITING_CONTROLLED_RESUME','observed_ms':at})
        store.add('integrity','deployment-amendment:'+amendment_id,None,at,at,
            {'kind':'CONTROLLED_SOURCE_DEPLOYMENT_AMENDMENT','amendment_id':amendment_id,
             'previous_reset_receipt_sha256':receipt['receipt_sha256'],'source_commit':source_commit,
             'model_config_unchanged':True,'research_rows_deleted':0})
    return record
