#!/usr/bin/env python3
"""Deterministic, network-free projection of the reviewed research shortlist.
Research references are retained separately from explicitly licensed public photos.
"""
import argparse, collections, hashlib, html, json, re
from pathlib import Path
from urllib.parse import urlparse

ALIASES = {
 'culture-moazzam-jahi-market': ('wikidata-q6886534','Exact named Hyderabad market; existing sourced entity'),
 'culture-laad-bazaar': ('wikidata-q6466530','Exact Charminar market; existing sourced entity'),
 'culture-mir-alam-mandi': ('wikidata-q131429557','Exact named Hyderabad market; existing sourced entity'),
 'official-sri-ujjaini-mahankali-temple': ('wikidata-q7878217','Same Ujjaini Mahakali temple, Secunderabad'),
 'eazydiner-691590': ('zythum-brewing-jubilee-hills','Same name and 74A Park View Enclave, Check Post Road, Jubilee Hills'),
}
CATEGORIES={'bookshop':'shopping','market':'shopping','creative_workshop':'art','cinema':'community'}
LICENSES={'CC0','Public domain','CC BY 2.0','CC BY 3.0','CC BY 4.0','CC BY-SA 2.0','CC BY-SA 3.0','CC BY-SA 4.0'}
def unique(a):return list(dict.fromkeys(a))
def clean(value):return re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>','',value or ''))).strip()
def public_url(s):
 try:
  u=urlparse(s);return u.scheme in ['https','http'] and bool(u.hostname) and not(u.username or u.password)
 except:return False

def convert(rows,previous):
 old={p['id']:p for p in previous}; result=[]; audits=[]; withheld=[]; used=set()
 for r in rows:
  sources=r.get('source_record_ids',[r['id']]); seed_ids=[s[5:] for s in sources if s.startswith('seed-') and s[5:] in old]
  alias=ALIASES.get(r['id']); identity=seed_ids[0] if seed_ids else alias[0] if alias else r['id']
  if identity in used: raise ValueError('Duplicate canonical identity: '+identity)
  used.add(identity); prior=old.get(identity,{})
  urls=unique([s['url'] for s in r['sources'] if public_url(s.get('url','')) and '/w/api.php' not in s['url']]+prior.get('sourceURLs',[]))[:30]
  if not urls:urls=unique([im['source_page'] for im in r['images'] if public_url(im.get('source_page',''))])[:30]
  category=CATEGORIES.get(r['category'],r['category'])
  locality=clean(r.get('locality')) or prior.get('neighborhood') or 'Hyderabad metropolitan area'
  address=clean(r.get('address')) or prior.get('address') or 'Street address not verified; check the linked source before visiting.'
  tags=unique([clean(t) for t in r.get('tags',[]) if clean(t)]+([r['category'].replace('_',' ')] if category!=r['category'] else []))[:60]
  researched=max([str(s.get('retrieved_at') or '')[:10] for s in r['sources'] if re.match(r'^\d{4}-\d{2}-\d{2}',str(s.get('retrieved_at') or ''))] or ['2026-10-09'])
  p={'id':identity,'name':clean(r['name']),'category':category,'neighborhood':locality,'address':address,
     'summary':f"A source-listed {r['category'].replace('_',' ')} place in {locality}. Current opening, admission and availability have not been verified.",
     'tags':tags,'sourceURLs':urls,'researchedAt':researched,'searchQuery':f"{clean(r['name'])} {locality} Hyderabad"}
  if prior and r['id'].startswith('seed-'):p['summary']=prior['summary']
  f=r.get('field_sources',{}).get('coordinates',{}); sourceurl=f.get('url'); coord=r.get('coordinates'); reason=None
  if r.get('coordinate_conflict'):reason='Conflicting source observations; no navigation point selected.'
  elif coord and not(17.15<=coord['latitude']<=17.75 and 78.10<=coord['longitude']<=78.80):reason='Source coordinate outside the supported Hyderabad map bounds.'
  elif coord:
   host=urlparse(sourceurl or '').hostname
   if host=='www.eazydiner.com' and re.fullmatch(r'/(hyderabad|kokapet)/[a-z0-9-]+-[1-9][0-9]*',urlparse(sourceurl).path):provider='EazyDiner';method='published_JSON-LD'
   elif host=='playo.co':provider='Playo';method='public_venue_data'
   elif prior.get('coordinateSource')=='Wikidata' and abs(prior.get('latitude',0)-coord['latitude'])<1e-8 and abs(prior.get('longitude',0)-coord['longitude'])<1e-8:
    provider='Wikidata';method='wikidata_coordinate_statement';sourceurl=next((s for s in prior['sourceURLs'] if re.fullmatch(r'https://www\.wikidata\.org/wiki/Q[1-9][0-9]*',s)),None)
   else:provider=None;reason='Coordinate source tuple could not be tied to the selected observation.'
   if provider and sourceurl:
    p.update(latitude=coord['latitude'],longitude=coord['longitude'],coordinateSource=provider,coordinateKind='poi',
      coordinateProvenance={'sourceURL':sourceurl,'method':method,'retrievedAt':researched,'entranceVerified':False,'independentlyVerified':False})
    if sourceurl not in p['sourceURLs']:p['sourceURLs'].append(sourceurl)
  elif prior.get('coordinateSource')=='Wikidata':
   sourceurl=next((s for s in prior['sourceURLs'] if re.fullmatch(r'https://www\.wikidata\.org/wiki/Q[1-9][0-9]*',s)),None)
   if sourceurl:
    p.update(latitude=prior['latitude'],longitude=prior['longitude'],coordinateSource='Wikidata',coordinateKind=prior['coordinateKind'],
      coordinateProvenance={'sourceURL':sourceurl,'method':'wikidata_coordinate_statement','retrievedAt':prior['researchedAt'],'entranceVerified':False,'independentlyVerified':False})
  public=[]
  for im in r['images']:
   if im.get('reuse_permission')=='license_asserted_by_Wikimedia_Commons' and im.get('license') in LICENSES and im.get('venue_specific_verified') and im.get('visual_verified') and im.get('http_verified') and not im.get('association_rejected') and im.get('eligible_source_associated_reference'):
    if urlparse(im['url']).hostname not in ['upload.wikimedia.org','thumb.wikimedia.org']:continue
    if not im.get('source_page','').startswith('https://commons.wikimedia.org/wiki/File:'):continue
    public.append({'url':im['url'],'sourceURL':im['source_page'],'credit':clean(im.get('credit')) or 'See Commons source for author',
      'license':im['license'],'licenseURL':(im.get('license_url') or '').replace('http://creativecommons.org/','https://creativecommons.org/') or 'https://commons.wikimedia.org/wiki/Commons:Public_domain',
      'sha256':im['sha256'],'width':im['width'],'height':im['height'],'checkedAt':im.get('checked_at',researched),
      'venueAssociationVerified':True,'archival':bool(im.get('archival'))})
  if public:
   p['publicImages']=public[:6];first=public[0]
   p.update(imageURL=first['url'],imageSourceURL=first['sourceURL'],imageCredit=first['credit'],imageRights=first['license'],imageLicenseURL=first['licenseURL'])
  refs=[]
  for im in r['images'][:2]:
   refs.append({'url':im['url'],'sourceURL':im['source_page'],'reusePermission':im.get('reuse_permission','unverified'),
    'license':im.get('license'),'sha256':im['sha256'],'checkedAt':im.get('checked_at') or im.get('observed_at') or researched,
    'venueAssociationVerified':bool(im.get('venue_specific_verified'))})
  fields=[]
  for field,v in r.get('field_sources',{}).items():
   src=[v['url']] if v.get('url') else v.get('urls',[])
   src=[u for u in src if public_url(u)]
   if src:fields.append({'field':field,'sourceURLs':src[:30],'method':v.get('method','source_reported')})
  p['research']={'datasetID':'hyderabad-editorial-1000-2026-10-10','recordID':r['id'],'sourceRecordIDs':unique(sources+[identity]),
    'category':r['category'],'fieldSources':fields,'photoReferences':refs,'currentOperationVerified':False,'admissionVerified':False,
    'selectionBasis':'Editorial category and locality diversity with two distinct source-associated image references; not measured popularity.'}
  if reason:p['research']['coordinateWithheldReason']=reason;withheld.append({'id':identity,'reason':reason})
  audits.append({'researchID':r['id'],'placeID':identity,'sourceRecordIDs':sources,'existingIDPreserved':identity in old,'aliasEvidence':alias[1] if alias else 'Existing seed identity' if seed_ids else None})
  result.append(p)
 return result,{'schemaVersion':1,'inputCount':len(rows),'placeCount':len(result),'coordinateCount':sum('latitude' in p for p in result),
  'coordinateSources':dict(collections.Counter(p.get('coordinateSource','none') for p in result)),
  'publicPhotoVenueCount':sum('imageURL' in p for p in result),'publicPhotoCount':sum(len(p.get('publicImages',[])) for p in result),
  'categoryCounts':dict(collections.Counter(p['category'] for p in result)),'existingIDsPreserved':sum(p['id'] in old for p in result),
  'coordinateWithheld':withheld,'aliases':audits,'imported':False}

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--input',required=True);ap.add_argument('--previous',required=True);ap.add_argument('--output',required=True);args=ap.parse_args()
 rows=json.load(open(args.input));previous=json.load(open(args.previous));out,report=convert(rows,previous)
 path=Path(args.output);path.write_text(json.dumps(out,indent=2,ensure_ascii=False)+'\n');report['catalogSHA256']=hashlib.sha256(path.read_bytes()).hexdigest()
 path.with_name('research-import-manifest.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k not in ['aliases']},indent=2))
if __name__=='__main__':main()
