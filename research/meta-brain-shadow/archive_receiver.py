"""Download, independently verify, then acknowledge compact Meta Brain day ZIPs."""
import argparse,hashlib,io,json,os,time,urllib.request,zipfile
from pathlib import Path

def packed(x):return json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False)
def request(url,body=None):
    headers={}
    if body is not None:
        token=os.environ.get('META_ARCHIVE_ACK_TOKEN','')
        if not token:raise RuntimeError('Protected externalization acknowledgement token is unavailable')
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
    data=packed(body).encode() if body is not None else None
    with urllib.request.urlopen(urllib.request.Request(url,data=data,headers=headers),timeout=180) as response:return response.read()
def checksum(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda:f.read(1048576),b''):h.update(data)
    return h.hexdigest()
def verify(path,expected):
    if checksum(path)!=expected:raise RuntimeError('External ZIP checksum mismatch')
    with zipfile.ZipFile(path) as z:
        if len(z.namelist())!=len(set(z.namelist())) or z.testzip() is not None:raise RuntimeError('External ZIP CRC/name failure')
        m=json.loads(z.read('manifest.json'))
        if not m['complete'] or m['kind']!='completed_day' or m['partition_timezone']!='Asia/Colombo':raise RuntimeError('Invalid day manifest')
        if set(z.namelist())!=set(m['files'])|{'manifest.json'}:raise RuntimeError('External manifest completeness failure')
        h=hashlib.sha256();size=0;ids=set();counts={}
        with z.open('events.ndjson') as f:
            for line in f:
                h.update(line);size+=len(line);r=json.loads(line)
                if r['id'] in ids or hashlib.sha256(packed(r['record']).encode()).hexdigest()!=r['sha256']:raise RuntimeError('External event integrity failure')
                if r['record'].get('execution_enabled') is not False or r['record'].get('shadow_only') is not True:raise RuntimeError('External shadow-only invariant failure')
                if r['record']['schema']!=m['schema'] or r['record']['epoch']!=m['epoch']:raise RuntimeError('External epoch/schema mismatch')
                lo=m['coverage']['start_ms'];hi=m['coverage']['end_ms_exclusive']
                if not lo<=r['observed_ms']<hi:raise RuntimeError('External Colombo partition mismatch')
                ids.add(r['id']);counts[r['stream']]=counts.get(r['stream'],0)+1
        spec=m['files']['events.ndjson']
        if h.hexdigest()!=spec['sha256'] or size!=spec['bytes'] or len(ids)!=m['event_count'] or counts!=m['counts']:raise RuntimeError('External archive population failure')
        return m
def once(base,folder):
    folder.mkdir(parents=True,exist_ok=True)
    status=json.loads(request(base+'/research/api/status'))
    if status['schema']!='meta-brain-decision-first-2.0' or status.get('execution_enabled') is not False:raise RuntimeError('Unexpected service/schema')
    receipts=[]
    for a in status['archives']:
        path=folder/(status['epoch']+'_'+a['date']+'.zip')
        if not path.exists():
            temp=path.with_suffix('.zip.partial');data=request(base+'/research/api/daily/'+a['date']+'.zip')
            temp.write_bytes(data);m=verify(temp,a['sha256']);temp.rename(path)
        else:m=verify(path,a['sha256'])
        if m['epoch']!=status['epoch'] or m['coverage']['date']!=a['date']:raise RuntimeError('External epoch/day mismatch')
        receipt={'date':a['date'],'sha256':a['sha256'],'external_location':str(path.resolve()),'verification':'CRC_MANIFEST_HASH_COUNTS_PASS'}
        request(base+'/research/api/external-receipt',receipt)
        receipts.append({**receipt,'bytes':path.stat().st_size,'acknowledged_at_ms':int(time.time()*1000)})
        path.with_suffix('.zip.sha256').write_text(a['sha256']+'  '+path.name+'\n',encoding='ascii')
    result={'status':'PASS','epoch':status['epoch'],'checked_at_ms':int(time.time()*1000),'archives':receipts}
    # Only the specific external-copy retention pause may recover automatically.
    # Initial migration, input, memory and other pauses require explicit control.
    fresh=json.loads(request(base+'/research/api/status'))
    if (fresh.get('capture_pause') or {}).get('reason')=='RETENTION_WAITING_FOR_VERIFIED_EXTERNAL_COPY':
        reset=json.loads(request(base+'/research/api/reset-receipt'))['receipt']
        result['retention_recovery']=json.loads(request(base+'/research/api/resume',{
            'epoch':fresh['epoch'],'preflight_sha256':reset['boot']['preflight_sha256']}))
    (folder/'LATEST_EXTERNALIZATION_RECEIPTS.json').write_text(json.dumps(result,indent=2))
    failure=folder/'RECEIVER_FAILURE.json'
    if failure.exists():failure.unlink()
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--base',required=True);p.add_argument('--folder',type=Path,required=True);a=p.parse_args()
    try:print(json.dumps(once(a.base.rstrip('/'),a.folder)))
    except Exception as e:
        a.folder.mkdir(parents=True,exist_ok=True)
        (a.folder/'RECEIVER_FAILURE.json').write_text(json.dumps({'status':'FAIL','error_type':type(e).__name__,'checked_at_ms':int(time.time()*1000)}))
        raise SystemExit(type(e).__name__)
