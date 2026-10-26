import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePlaceImages,withPlaceImage} from '../src/place-images.js';
const photo={placeID:'one-cafe',imageURL:'https://images.example.org/cafe.jpg',sourceURL:'https://cafe.example.org/hyderabad',title:'One Cafe Hyderabad',origin:'cafe.example.org',query:'One Cafe Hyderabad photos',actor:'hooli/google-images-scraper',runID:'A1234567890',datasetID:'B1234567890',matchScore:0.8,matchEvidence:'name_and_location',reusePermission:'unverified',status:'source-preview',downloadVerified:true,width:800,height:600,bytes:20000,sha256:'a'.repeat(64),perceptualHash:'b'.repeat(16),checkedAt:'2026-10-24T12:00:00Z'};
const feed=(items:unknown[])=>({version:1,actor:'hooli/google-images-scraper',generatedAt:'2026-10-24T12:00:00Z',items});
test('missing imagery is enriched without changing place identity or coordinates',()=>{
 const place={id:'one-cafe',name:'One Cafe',latitude:17.4,longitude:78.4};
 const result=withPlaceImage(place,parsePlaceImages(feed([photo]))) as typeof place & {imageURL:string;imageSourceURL:string;imageRights:string};
 assert.equal(result.imageURL,photo.imageURL);assert.equal(result.imageSourceURL,photo.sourceURL);assert.equal(result.imageRights,'source-preview-reuse-unverified');
 assert.equal(result.id,place.id);assert.equal(result.name,place.name);assert.equal(result.latitude,place.latitude);assert.equal(result.longitude,place.longitude);
 assert.equal((place as any).imageURL,undefined);
});
test('curated or merchant imagery always wins',()=>{const p={id:'one-cafe',imageURL:'https://owner.example.org/own.jpg'};assert.equal(withPlaceImage(p,parsePlaceImages(feed([photo]))),p);});
test('unknown place IDs never inherit a photo',()=>{const p={id:'other'};assert.equal(withPlaceImage(p,parsePlaceImages(feed([photo]))),p);});
test('private, credentialed, insecure and non-web URLs are rejected',()=>{
 for(const bad of ['http://example.org/a','https://127.0.0.1/a','https://10.0.0.1/a','https://[::1]/a','https://localhost/a','https://secret@images.example.org/a','file:///etc/passwd','https://host.internal/a']){
  assert.throws(()=>parsePlaceImages(feed([{...photo,imageURL:bad}])));assert.throws(()=>parsePlaceImages(feed([{...photo,sourceURL:bad}])));
 }
});
test('duplicate identities and duplicate content cannot silently win',()=>{assert.throws(()=>parsePlaceImages(feed([photo,photo])));assert.throws(()=>parsePlaceImages(feed([photo,{...photo,placeID:'two'}])));});
test('invalid dimensions, fabricated validation and unsupported rights claims are rejected',()=>{
 for(const patch of [{width:100},{width:10000,height:10000},{bytes:10000000},{downloadVerified:false},{reusePermission:'licensed'},{status:'pending'},{sha256:'fake'}])assert.throws(()=>parsePlaceImages(feed([{...photo,...patch}])));
});
test('raw actor fields and credentials never enter the mobile projection',()=>{
 assert.throws(()=>parsePlaceImages(feed([{...photo,apiToken:'secret'}])));
 const result=withPlaceImage({id:photo.placeID},parsePlaceImages(feed([photo]))) as Record<string,unknown>;
 assert.equal(result.runID,undefined);assert.equal(result.query,undefined);assert.equal(result.apiToken,undefined);
});
