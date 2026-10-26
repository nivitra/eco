import {readFileSync} from 'node:fs';
import {isIP} from 'node:net';
import {z} from 'zod';
function publicHTTPS(value:string):boolean {
  try {
    const u=new URL(value),host=u.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&host!=='localhost'&&!/\.(local|internal|localhost)$/.test(host)&&!isIP(host)&&host.includes('.');
  } catch{return false;}
}
const url=z.string().max(8000).refine(publicHTTPS);
export const placeImageSchema=z.object({
  placeID:z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),imageURL:url,sourceURL:url,
  title:z.string().max(4000),origin:z.string().max(500),query:z.string().min(1).max(2000),
  actor:z.literal('hooli/google-images-scraper'),runID:z.string().regex(/^[A-Za-z0-9]{10,40}$/),datasetID:z.string().regex(/^[A-Za-z0-9]{10,40}$/),
  matchScore:z.number().finite().min(0).max(1),matchEvidence:z.enum(['catalogue_source_page','name_and_source_host','name_and_location']),
  reusePermission:z.literal('unverified'),status:z.literal('source-preview'),downloadVerified:z.literal(true),
  width:z.number().int().min(240).max(20000),height:z.number().int().min(240).max(20000),
  bytes:z.number().int().positive().max(8*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/),perceptualHash:z.string().regex(/^[a-f0-9]{16}$/),checkedAt:z.iso.datetime({offset:true}),
}).strict().refine(p=>p.width*p.height<=40_000_000&&Math.max(p.width,p.height)>=480&&p.width/p.height>0.45&&p.width/p.height<2.8,'Invalid photo dimensions');
export type PlaceImage=z.infer<typeof placeImageSchema>;
export function parsePlaceImages(value:unknown):ReadonlyMap<string,PlaceImage> {
  const feed=z.object({version:z.literal(1),actor:z.literal('hooli/google-images-scraper'),generatedAt:z.iso.datetime({offset:true}),items:z.array(placeImageSchema).max(5000)}).strict().parse(value);
  const result=new Map<string,PlaceImage>(),hashes=new Set<string>();
  for(const item of feed.items){
    if(result.has(item.placeID)||hashes.has(item.sha256))throw new Error('Duplicate place identity or photo in image feed');
    result.set(item.placeID,item);hashes.add(item.sha256);
  }
  return result;
}
function load():ReadonlyMap<string,PlaceImage> {
  try{return parsePlaceImages(JSON.parse(readFileSync(new URL('../data/place-images.json',import.meta.url),'utf8')));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')console.error('Place image feed rejected; preserving catalogue imagery.');return new Map();}
}
const sourceImages=load();
/** Derived photo projection. Place facts and existing merchant/curated imagery win. */
export function withPlaceImage<T extends {id:string;imageURL?:string|null}>(place:T,images:ReadonlyMap<string,PlaceImage>=sourceImages):T {
  if(place.imageURL)return place;
  const photo=images.get(place.id);if(!photo)return place;
  return {...place,imageURL:photo.imageURL,imageSourceURL:photo.sourceURL,imageCredit:'Photo source: '+new URL(photo.sourceURL).hostname,imageRights:'source-preview-reuse-unverified'};
}
