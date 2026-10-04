"""Independent, fail-closed readiness evaluator. Never fabricates evidence.

Proof file format is described in observer_implementation_handover.md. External
deployment and OS isolation attestations must match this exact executable
and seal mode. Unit fixtures and local snapshots are insufficient live evidence.
"""
import argparse
import json
from pathlib import Path
import observer as o

def audit(observer,proofs,now=None):
    now=o.stamp() if now is None else now
    ledger=observer.ledger;start=ledger.get('readiness:start');failures=[];incomplete=[]
    if not start:return {'status':'INCOMPLETE','completedHours':0,'blockers':['READINESS_NOT_STARTED'],'actual_start_utc':None}
    first=start['startAt'];end=first+86400000
    if now<end:incomplete.append('FULL_24_HOURS_NOT_ELAPSED')
    if start['implementationHash']!=observer.hash:failures.append('IMPLEMENTATION_CHANGED')
    expected={(s,b) for s in o.SYMBOLS for b in range(first,end,o.SURFACE)}
    snaps=ledger.rows('INPUT_SNAPSHOT')
    actual={(s['symbol'],s['barCloseAt']) for s in snaps if first<=s['barCloseAt']<end}
    if actual!=expected:incomplete.append('SCHEDULED_SYMBOL_SURFACE_COVERAGE_INCOMPLETE')
    for s,b in expected:
        if not ledger.get(f'ack:{s}:{b}'):incomplete.append('SCAN_ACK_MISSING');break
        for e in ['V2','V3']:
            if not ledger.get(f'candidate:{e}:{s}:{b}'):incomplete.append('REQUIRED_ENGINE_RECORD_MISSING');break
    counts=ledger.count();attempted=sum(x['attempted'] for x in counts);accepted=sum(x['accepted'] for x in counts)
    if attempted!=accepted:failures.append('ATTEMPTED_NOT_DURABLY_ACCEPTED')
    checks=ledger.verify()
    if any(checks[k] for k in ['unresolvedRefs','chainFailures','rawHashFailures']):failures.append('WAL_OR_REFERENCE_HASH_RECONCILIATION_FAILED')
    candidates=[c for c in ledger.rows('EDGE_CANDIDATE') if first<=c['barCloseAt']<end]
    by_snapshot={}
    for c in candidates:by_snapshot.setdefault(c['inputSnapshotId'],[]).append(c)
    late=0;eligible=0;feature_errors=0;late_use=0
    for s in snaps:
        if not first<=s['barCloseAt']<end:continue
        late+=bool(s['strictAvailabilityFailed'])
        material=observer.materialize(s)
        if any(not o.available(b,s['decisionAt']) for group in s['inputBarRefs'] for b in material[group]):late_use+=1
        f=o.feature_bundle(material)
        for c in by_snapshot.get(s['inputSnapshotId'],[]):
            eligible+=c['prequoteEligible']
            for field in ['premiumZ','relativeStrength60','premiumBaselineHash','relativeStrength60DerivationHash']:
                x,y=f[field],c[field]
                if x!=y and not (isinstance(x,(int,float)) and isinstance(y,(int,float)) and abs(x-y)<=1e-12):feature_errors+=1
            if c.get('adapterFailure'):failures.append('CANDIDATE_ADAPTER_FAILED')
    if late_use:failures.append('LATE_INPUT_USED_IN_SEALED_SNAPSHOT')
    if feature_errors:failures.append('FEATURE_RECEIPT_REPRODUCTION_FAILED')
    if not eligible and len(actual)==len(expected):failures.append('STRICT_TIMING_OR_NATIVE_GATES_YIELD_ZERO_CANDIDATES_TIMING_STUDY_V2_REQUIRED')
    # Proofs are exact-version operational evidence, never inferred from old cohorts.
    for k in ['deployment','outcome_isolation','fixture_parity','wal_restart','snapshot']:
        proof=proofs.get(k)
        if not proof or proof.get('status')!='PASS':incomplete.append(k.upper()+'_PROOF_REQUIRED');continue
        if proof.get('observerImplementationHash')!=observer.hash:failures.append(k.upper()+'_IMPLEMENTATION_MISMATCH')
    isolation=proofs.get('outcome_isolation',{})
    if isolation.get('sealMode')!=start['outcomeSealMode']:incomplete.append('OUTCOME_SEAL_MODE_MISMATCH')
    required=['captureCannotReadOutcomes','statusCannotReadOutcomes','statusCannotReadCapture',
        'outcomesCannotWriteCapture','outcomesCanReadCapture','outcomesCanReadOwnArchive',
        'statusCannotWriteReceiptWAL','captureCannotWriteReceiptWAL','outcomesReadLiveSQLiteWAL']
    if not all(isolation.get('checks',{}).get(k) is True for k in required):incomplete.append('OS_ACCESS_SEPARATION_NOT_PROVEN')
    deployment=proofs.get('deployment',{})
    for k in ['build','deployment','pod','baselineSettingsHash','postSettingsHash','baselineV2Hash','postV2Hash','baselineV3Hash','postV3Hash']:
        if not deployment.get(k):incomplete.append('DEPLOYMENT_IDENTITIES_AND_CONTROLS_UNVERIFIED');break
    if deployment.get('executionAllowed') is not False or deployment.get('mode')!='paper':incomplete.append('PAPER_EXECUTION_ISOLATION_UNVERIFIED')
    for kind in ['Settings','V2','V3']:
        if deployment.get('baseline'+kind+'Hash')!=deployment.get('post'+kind+'Hash'):failures.append('PRODUCTION_'+kind.upper()+'_CHANGED')
    daily=[]
    for day in sorted({o.utc(first)[:10],o.utc(end-1)[:10]}):
        folder=ledger.folder/'daily'/day
        if not folder.exists():incomplete.append('DAILY_IMMUTABLE_SNAPSHOT_MISSING');continue
        try:daily.append(o.verify_snapshot(folder))
        except Exception as e:failures.append(str(e))
    # Delayed outcomes for the last surface require a final drain. Uncompleted
    # horizons do not become zeros and do not disappear from attempted counts.
    missing_outcomes=0
    receipt_folder=ledger.folder.parent/'outcome_receipts'
    receipt_ledger=o.ReadOnlyLedger(receipt_folder) if (receipt_folder/'capture.sqlite').exists() else None
    for c in candidates:
        if not c['prequoteEligible']:continue
        for h in [15,30,60,120]:
            if not receipt_ledger or not receipt_ledger.get(f'outcome:{c["candidateId"]}:{h}'):missing_outcomes+=1
    if receipt_ledger:receipt_ledger.close()
    if missing_outcomes:incomplete.append('OUTCOME_HORIZONS_OR_CENSOR_DRAIN_PENDING')
    if now<end:status='INCOMPLETE'
    elif failures:status='FAIL'
    elif incomplete:status='INCOMPLETE'
    else:status='PASS'
    return {'schemaVersion':o.SCHEMA,'cohortId':o.COHORT['cohort_id'],'status':status,'readinessStartAt':first,
      'readinessEndAt':end,'evaluatedAt':now,'completedHours':len(observer.completed_hours(first,now)),
      'expectedSurfaces':len(expected),'accountedSurfaces':len(actual),'attempted':attempted,'accepted':accepted,'skipped':0,
      'strictUnavailableSurfaces':late,'strictUnavailableSurfaceRate':late/len(actual) if actual else None,
      'lateInputsUsed':late_use,'featureReproductionErrors':feature_errors,'eligibleCandidates':eligible,
      'unresolvedRefs':checks['unresolvedRefs'],'missingOutcomeRecords':missing_outcomes,'dailySnapshots':daily,
      'failures':sorted(set(failures)),'blockers':sorted(set(incomplete)),
      'observerImplementationHash':observer.hash,'registrationHash':o.REGISTRATION,'universeHash':o.UNIVERSE,
      'outcomeSealMode':start['outcomeSealMode'],'proofsHash':o.digest(proofs),'actual_start_utc':None,
      'timingStudyV2Needed':bool(late and eligible==0),'noProductionBehavioralTradingRulePromoted':True}

def finalize(observer,proofs,folder):
    report=audit(observer,proofs);folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    (folder/'readiness_audit_result.json').write_bytes(o.canonical(report))
    if report['status']=='PASS':
        receipt={**report,'receiptCommittedAt':o.stamp(),'signerIdentity':None,'signature':None}
        observer.ledger.append('readiness:pass',{'recordType':'READINESS_RECEIPT',**receipt})
        o.immutable(folder/'readiness_receipt.json',o.canonical(receipt))
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--data',required=True);p.add_argument('--proofs',required=True);p.add_argument('--output',required=True)
    x=p.parse_args();ledger=o.Ledger(x.data);obs=o.Observer(ledger)
    try:print(json.dumps(finalize(obs,json.loads(Path(x.proofs).read_text()),x.output)))
    finally:obs.adapter.close();ledger.close()
