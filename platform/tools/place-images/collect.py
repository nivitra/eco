#!/usr/bin/env python3
"""Bounded, resumable Apify image collection -> validated place-ID photo feed.

Credentials stay in APIFY_TOKEN or an explicit private token file. Search results
are source previews, not a declaration that a publisher granted a reuse licence.
"""
from __future__ import annotations
import argparse, concurrent.futures, datetime, hashlib, ipaddress, json, os, re, socket, time, unicodedata
import urllib.error, urllib.parse, urllib.request
from pathlib import Path
from PIL import Image, ImageOps

PLATFORM = Path(__file__).resolve().parents[2]
REPO = PLATFORM.parents[2]
WORK = REPO / 'work/google-images-2026-10-24'
ACTOR = 'hooli~google-images-scraper'
MAX_IMAGE_BYTES = 8 * 1024 * 1024
TERMINAL = {'SUCCEEDED','FAILED','TIMED-OUT','ABORTED'}
GENERIC = set('the a an and at by for of in cafe cafes coffee house restaurant restaurants bar brewpub bistro kitchen lounge club hotel photos venue exterior interior jubilee hills banjara hyderabad telangana india'.split())
AREAS = ['jubilee hills','banjara hills','gachibowli','kondapur','kokapet','madhapur','abids','kukatpally','hitech city','manikonda','secunderabad','nallagandla','chandanagar','begumpet','miyapur']
BAD_IMAGES = re.compile(r'\b(logo|logos|icon|icons|coupon|voucher|vector|poster|flyer|menu|brochure|stock photo|qr code)\b', re.I)

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
def normalized(value):
    value = unicodedata.normalize('NFKD', str(value)).encode('ascii','ignore').decode().lower()
    return ' '.join(re.findall(r'[a-z0-9]+', value))
def atomic(path, data):
    path = Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    temp = path.with_suffix(path.suffix+'.tmp'); temp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n'); temp.replace(path)
def read(path, fallback=None):
    try:return json.loads(Path(path).read_text())
    except FileNotFoundError:return fallback

def catalog():
    merged={p['id']:p for p in read(PLATFORM/'data/independent-places.json',[])}
    for p in read(PLATFORM/'data/research-places.json',[]): merged[p['id']]=p
    return list(merged.values())

def query_for(place):
    area=place.get('neighborhood','').split('·')[0].strip()
    return ' '.join((place['name'].replace('—',' '),area,'Hyderabad photos')).strip().replace('  ',' ')

def plan():
    priorities={'cafes':0,'food':1,'nightlife':2,'art':3,'heritage':4,'parks':5,'nature':6,'sports':7,'games':8}
    places=[p for p in catalog() if not p.get('imageURL') and not re.search(r'\b(demo|fictional|synthetic)\b', p['name'],re.I)]
    places.sort(key=lambda p:(priorities.get(p['category'],9),p['id']))
    rows=[{'placeID':p['id'],'name':p['name'],'neighborhood':p.get('neighborhood',''),'query':query_for(p)} for p in places]
    assert len({p['query'] for p in rows})==len(rows), 'Ambiguous image query: add a branch/address qualifier.'
    atomic(WORK/'queries.json',rows)
    return rows

def token():
    value=os.environ.get('APIFY_TOKEN','').strip()
    if not value:value=Path(os.environ.get('APIFY_TOKEN_FILE',str(REPO/'work/private/apify-google-images.token'))).read_text().strip()
    if not value:raise RuntimeError('APIFY_TOKEN is required')
    return value

def api(path, body=None):
    request=urllib.request.Request('https://api.apify.com/v2/'+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+token(),'Content-Type':'application/json'},method='GET' if body is None else 'POST')
    try:
        with urllib.request.urlopen(request,timeout=45) as r:return json.load(r)
    except urllib.error.HTTPError as e:raise RuntimeError(f'Apify HTTP {e.code} for {path.split("?")[0]}') from None

def ledger():
    result=read(WORK/'runs.json',{'version':1,'actor':ACTOR,'jobs':[]})
    pilot=read(WORK/'pilot-run.json')
    if pilot and not any(j['runID']==pilot['data']['id'] for j in result['jobs']):
        result['jobs'].append({'runID':pilot['data']['id'],'reservedUsd':0.25,'queries':read(WORK/'pilot-queries.json'), 'kind':'pilot','credentialFingerprint':hashlib.sha256((REPO/'work/private/apify-google-images.account1.token').read_bytes()).hexdigest()[:12] if (REPO/'work/private/apify-google-images.account1.token').exists() else None})
    return result

def refresh(job):
    data=api('actor-runs/'+job['runID'])['data']
    for key in ['status','defaultDatasetId','usageTotalUsd','chargedEventCounts','statusMessage','startedAt','finishedAt']:job[key]=data.get(key)
    if data['status'] in TERMINAL:
        try:
            rows=api('datasets/'+data['defaultDatasetId']+'/items?clean=true&format=json')
        except RuntimeError as error:
            if 'HTTP 402' not in str(error):raise
            job['datasetLocked']=True
            return job
        job.pop('datasetLocked',None)
        atomic(WORK/'raw'/f"{job['runID']}.json",rows)
        job['items']=len(rows)
        completed_queries={r.get('query') for r in rows}
        complete=data['status']=='SUCCEEDED' and 'charging limit' not in (data.get('statusMessage') or '').lower()
        job['completedPlaceIDs']=[q['placeID'] for q in job['queries'] if complete or q['query'] in completed_queries]
        job['rawRetrieved']=True
    return job

def collect(budget=12.0, batch_size=400, parallel=2, per_query=3, retry_missing=False):
    rows=plan(); book=ledger(); started=time.monotonic(); fingerprint=hashlib.sha256(token().encode()).hexdigest()[:12]; attempted=set()
    if retry_missing:
        pictured={p['placeID'] for p in read(PLATFORM/'data/place-images.json',{'items':[]})['items']}
        rows=[{**q,'query':q['query'].removesuffix(' photos')+' venue exterior interior'} for q in rows if q['placeID'] not in pictured]
    for job in book['jobs']:
        if job.get('rawRetrieved') and 'completedPlaceIDs' not in job:
            raw=read(WORK/'raw'/f"{job['runID']}.json",[]);queries={r.get('query') for r in raw}
            complete=job.get('status')=='SUCCEEDED' and 'charging limit' not in (job.get('statusMessage') or '').lower()
            job['completedPlaceIDs']=[q['placeID'] for q in job['queries'] if complete or q['query'] in queries]
    while True:
        for job in book['jobs']:
            if not job.get('rawRetrieved') and not (job.get('datasetLocked') and job.get('credentialFingerprint')!=fingerprint):refresh(job)
        atomic(WORK/'runs.json',book)
        if any(j.get('datasetLocked') and j.get('credentialFingerprint')==fingerprint for j in book['jobs']):
            print('Apify has locked a dataset at the account usage limit. Add credits to this account and resume; no re-scrape was started.',flush=True);break
        spent=sum(float(j.get('usageTotalUsd') or 0) for j in book['jobs'] if j.get('status') in TERMINAL)
        active=[j for j in book['jobs'] if j.get('status') not in TERMINAL]
        reserved=sum(j['reservedUsd'] for j in active)
        blocked=any(j.get('status')=='ABORTED' and 'maximum usage' in (j.get('statusMessage') or '').lower() and j.get('credentialFingerprint')==fingerprint for j in book['jobs'])
        if blocked:
            print('Current Apify account usage limit reached; remaining queries are retained for another credential or top-up.',flush=True);break
        seen=set(attempted)
        for job in book['jobs']:
            if not retry_missing or job.get('kind')=='missing-retry-v1':seen.update(job.get('completedPlaceIDs',[]))
            if job.get('status') not in TERMINAL:seen.update(q['placeID'] for q in job['queries'])
        pending=[q for q in rows if q['placeID'] not in seen]
        while pending and len(active)<parallel:
            affordable=max(0,int((budget-spent-reserved-0.0002)/(per_query*0.0035)))
            batch=pending[:min(batch_size,affordable)]
            if not batch:break
            cap=round(len(batch)*per_query*0.0035+0.0002,4)
            if spent+reserved+cap>budget:break
            input_data={'queries':[q['query'] for q in batch],'maxResultsPerQuery':per_query}
            params=urllib.parse.urlencode({'timeout':1200,'memory':2048,'maxItems':len(batch)*per_query,'maxTotalChargeUsd':cap})
            result=api('acts/'+ACTOR+'/runs?'+params,input_data)['data']
            job={'runID':result['id'],'reservedUsd':cap,'queries':batch,'kind':'missing-retry-v1' if retry_missing else 'catalogue','credentialFingerprint':fingerprint,'status':result['status'],'defaultDatasetId':result['defaultDatasetId']}
            book['jobs'].append(job);active.append(job);reserved+=cap;pending=pending[len(batch):];attempted.update(q['placeID'] for q in batch)
            atomic(WORK/'runs.json',book)
            print(json.dumps({'event':'started','runID':job['runID'],'places':len(batch),'chargeCapUsd':cap}),flush=True)
        print(json.dumps({'event':'progress','active':len(active),'remainingQueries':len(pending),'actualUsd':round(spent,4),'reservedUsd':round(reserved,4),'seconds':int(time.monotonic()-started)}),flush=True)
        if not active:
            if pending:print('Budget cap reached; remaining queries retained in the plan.',flush=True)
            break
        time.sleep(15)
    atomic(WORK/'runs.json',book)

def public_url(value, resolve=False):
    try:
        u=urllib.parse.urlsplit(value)
        if u.scheme not in ('https','http') or not u.hostname or u.username or u.password or u.port not in (None,80,443):return False
        host=u.hostname.lower()
        if host=='localhost' or host.endswith(('.local','.internal','.localhost')):return False
        try:
            if not ipaddress.ip_address(host).is_global:return False
        except ValueError:pass
        if resolve:
            addresses=socket.getaddrinfo(host,u.port or (443 if u.scheme=='https' else 80),type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):return False
        return True
    except (ValueError,OSError):return False

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        if not public_url(newurl,resolve=True):raise ValueError('Unsafe image redirect')
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def score(place,row):
    source=row.get('contentUrl','');image=row.get('imageUrl','')
    if not public_url(source) or not public_url(image):return None,'invalid_public_url'
    if not source.startswith('https://'):return None,'insecure_source_page'
    title=normalized(row.get('title','')); text=normalized(' '.join((row.get('title',''),source)))
    if BAD_IMAGES.search(title) or BAD_IMAGES.search(normalized(urllib.parse.urlsplit(image).path)):return None,'non_photo_content'
    if any(x in urllib.parse.urlsplit(image).hostname for x in ['gstatic.com','google.com']):return None,'search_thumbnail_not_original'
    name_tokens={x for x in normalized(place['name']).split() if len(x)>2 and x not in GENERIC}
    expected_areas=[a for a in AREAS if a in normalized(place.get('neighborhood','')+' '+place['name'])]
    actual_areas=[a for a in AREAS if a in text]
    if expected_areas and actual_areas and not set(expected_areas)&set(actual_areas):return None,'conflicting_branch_area'
    text_tokens=set(text.split());identity=len(name_tokens&text_tokens)/max(1,len(name_tokens))
    exact_source=source.rstrip('/').split('?')[0] in {u.rstrip('/').split('?')[0] for u in place.get('sourceURLs',[])}
    known_host=urllib.parse.urlsplit(source).hostname in {urllib.parse.urlsplit(u).hostname for u in place.get('sourceURLs',[]) if public_url(u)}
    location=any(a in text for a in expected_areas) or 'hyderabad' in text or 'secunderabad' in text
    if identity<0.6 and not exact_source:return None,'weak_place_identity'
    if not location and not exact_source and not known_host:return None,'missing_location_evidence'
    value=identity*0.6+(0.18 if location else 0)+(0.2 if exact_source else 0.1 if known_host else 0)
    return round(min(1,value),4),('catalogue_source_page' if exact_source else 'name_and_source_host' if known_host else 'name_and_location')

def download_candidate(candidate):
    url=candidate['imageURL']
    if url.startswith('http:'):url='https:'+url[5:]
    key=hashlib.sha256(url.encode()).hexdigest();folder=WORK/'images';folder.mkdir(exist_ok=True)
    original=folder/(key+'.original');meta=folder/(key+'.json')
    cached=read(meta)
    failure=read(folder/(key+'.failure.json'))
    if failure and time.time()-failure.get('timestamp',0)<21600:raise ValueError(failure['reason'])
    if cached and original.exists():return {**candidate,**cached}
    if not public_url(url,resolve=True):raise ValueError('non_public_image_host')
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; KultureImageCollector/1.0)','Accept':'image/avif,image/webp,image/*;q=0.9'})
    opener=urllib.request.build_opener(SafeRedirect())
    with opener.open(req,timeout=18) as response:
        if response.status!=200:raise ValueError('image_http_status')
        mime=response.headers.get_content_type()
        if mime not in ('image/jpeg','image/png','image/webp','image/avif','image/gif'):raise ValueError('not_supported_raster_image')
        if int(response.headers.get('Content-Length','0'))>MAX_IMAGE_BYTES:raise ValueError('image_too_large')
        data=response.read(MAX_IMAGE_BYTES+1)
        if len(data)>MAX_IMAGE_BYTES:raise ValueError('image_too_large')
        final=response.url
        if not final.startswith("https://"):raise ValueError("insecure_image_redirect")
    import io
    with Image.open(io.BytesIO(data)) as image:
        w,h=image.size
        if w*h>40_000_000 or min(w,h)<240 or max(w,h)<480 or not 0.45<w/h<2.8:raise ValueError('image_dimensions')
        image=ImageOps.exif_transpose(image).convert('RGB');image.thumbnail((800,800))
        sha=hashlib.sha256(data).hexdigest()
        pixels=list(image.resize((9,8)).convert('L').getdata())
        dhash=sum((int(pixels[y*9+x]>pixels[y*9+x+1])<<(y*8+x)) for y in range(8) for x in range(8))
        image.save(folder/(sha+'.webp'),'WEBP',quality=82)
    original.write_bytes(data)
    result={'imageURL':final,'width':w,'height':h,'sha256':sha,'perceptualHash':f'{dhash:016x}','bytes':len(data),'checkedAt':now(),'downloadVerified':True}
    atomic(meta,result)
    return {**candidate,**result}

def process(workers=6):
    places={p['id']:p for p in catalog()};book=ledger();candidates=[];rejected=[]
    for job in book['jobs']:
        mapping={q['query']:q['placeID'] for q in job['queries']}
        for row in read(WORK/'raw'/f"{job['runID']}.json",[]):
            pid=mapping.get(row.get('query'))
            if not pid or pid not in places:rejected.append({'query':row.get('query'),'reason':'unknown_query_identity'});continue
            value,reason=score(places[pid],row)
            if value is None:rejected.append({'placeID':pid,'imageURL':row.get('imageUrl'),'reason':reason});continue
            candidates.append({'placeID':pid,'imageURL':row['imageUrl'],'sourceURL':row['contentUrl'],'title':row.get('title',''),'origin':row.get('origin') or urllib.parse.urlsplit(row['contentUrl']).hostname,'query':row['query'],'actor':ACTOR.replace('~','/'),'runID':job['runID'],'datasetID':job.get('defaultDatasetId'),'matchScore':value,'matchEvidence':reason,'reusePermission':'unverified'})
    # One download per image URL, with no provider credential forwarded to it.
    unique={c['imageURL']:c for c in candidates};downloads={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures={executor.submit(download_candidate,c):url for url,c in unique.items()}
        for i,f in enumerate(concurrent.futures.as_completed(futures)):
            url=futures[f]
            try:downloads[url]=f.result()
            except Exception as e:
                reason=str(e)[:120]
                rejected.append({'imageURL':url,'reason':reason})
                atomic(WORK/'images'/(hashlib.sha256(url.encode()).hexdigest()+'.failure.json'),{'reason':reason,'timestamp':time.time()})
            if i%100==0:print(json.dumps({'event':'images_checked','completed':i+1,'total':len(unique)}),flush=True)
    valid=[]
    for c in candidates:
        d=downloads.get(c['imageURL'])
        if d:valid.append({**d,**{k:v for k,v in c.items() if k!='imageURL'}})
    valid.sort(key=lambda c:(-c['matchScore'],-min(c['width'],c['height']),c['placeID'],c['imageURL']))
    reviews=read(WORK/'photo-reviews.json',{'rejectedHashes':{}})
    # Preserve previously accepted photos; this pass fills gaps, not replacements.
    previous=read(PLATFORM/'data/place-images.json',{'items':[]})
    chosen={c['placeID']:c for c in previous['items'] if c['placeID'] in places and not places[c['placeID']].get('imageURL') and c['sha256'] not in reviews.get('rejectedHashes',{})}
    owners={c['sha256']:pid for pid,c in chosen.items()}
    hashes=[(int(c['perceptualHash'],16),pid) for pid,c in chosen.items()]
    for c in valid:
        pid=c['placeID']
        if c['sha256'] in reviews.get('rejectedHashes',{}):
            rejected.append({'placeID':pid,'imageURL':c['imageURL'],'reason':'visual_review: '+reviews['rejectedHashes'][c['sha256']]});continue
        if pid in chosen or places[pid].get('imageURL'):continue
        if c['sha256'] in owners and owners[c['sha256']]!=pid:
            rejected.append({'placeID':pid,'imageURL':c['imageURL'],'reason':'duplicate_image_for_another_place'});continue
        perceptual=int(c['perceptualHash'],16)
        if any(bin(perceptual^h).count("1")<=3 and other!=pid for h,other in hashes):
            rejected.append({'placeID':pid,'imageURL':c['imageURL'],'reason':'near_duplicate_for_another_place'});continue
        c['status']='source-preview';chosen[pid]=c;owners[c['sha256']]=pid;hashes.append((perceptual,pid))
    feed={'version':1,'actor':ACTOR.replace('~','/'),'generatedAt':now(),'items':sorted(chosen.values(),key=lambda c:c['placeID'])}
    atomic(PLATFORM/'data/place-images.json',feed)
    atomic(WORK/'candidates.json',valid);atomic(WORK/'rejections.json',rejected)
    summary={'cataloguePlaces':len(places),'existingPhotos':sum(bool(p.get('imageURL')) for p in places.values()),'scrapedResults':sum(j.get('items',0) for j in book['jobs']),'validatedCandidates':len(valid),'newPlacePhotos':len(chosen),'remainingWithoutPhoto':sum(not p.get('imageURL') and pid not in chosen for pid,p in places.items()),'actualApifyUsd':round(sum(j.get('usageTotalUsd') or 0 for j in book['jobs']),4),'rightsStatus':'Source previews; no licence or owner permission is asserted.'}
    atomic(WORK/'summary.json',summary);print(json.dumps(summary,indent=2),flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['plan','collect','process']);parser.add_argument('--budget',type=float,default=12);parser.add_argument('--batch-size',type=int,default=400);parser.add_argument('--parallel',type=int,default=2);parser.add_argument('--workers',type=int,default=6);parser.add_argument('--per-query',type=int,choices=[1,2,3],default=3);parser.add_argument('--retry-missing',action='store_true')
    args=parser.parse_args();WORK.mkdir(parents=True,exist_ok=True)
    if args.command=='plan':print(json.dumps({'queries':len(plan())}))
    elif args.command=='collect':collect(args.budget,args.batch_size,args.parallel,args.per_query,args.retry_missing)
    else:process(args.workers)
if __name__=='__main__':main()
