import {z} from 'zod';

export const researchSources = ['EazyDiner','Playo','Wikidata'] as const;
export const coordinateProvenanceSchema=z.object({
  sourceURL:z.string().max(2048),method:z.enum(['published_JSON-LD','public_venue_data','wikidata_coordinate_statement']),
  retrievedAt:z.string().max(64).refine(s=>Number.isFinite(Date.parse(s))),
  entranceVerified:z.literal(false),independentlyVerified:z.literal(false),
}).strict();
export type ResearchCoordinateProvenance=z.infer<typeof coordinateProvenanceSchema>;
export function validResearchCoordinateSource(source:unknown,url:unknown,method:unknown):boolean {
  if(typeof url!=='string')return false;
  try {
    const u=new URL(url);
    if(u.href!==url||u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash)return false;
    if(source==='EazyDiner')return method==='published_JSON-LD'&&u.hostname==='www.eazydiner.com'&&/^\/(?:hyderabad|kokapet)\/[a-z0-9-]+-[1-9][0-9]*$/.test(u.pathname);
    if(source==='Playo')return method==='public_venue_data'&&u.hostname==='playo.co'&&/^\/venues\/[A-Za-z0-9_@().-]+\/[A-Za-z0-9_@().-]+$/.test(u.pathname);
    return source==='Wikidata'&&method==='wikidata_coordinate_statement'&&u.hostname==='www.wikidata.org'&&/^\/wiki\/Q[1-9][0-9]*$/.test(u.pathname);
  } catch{return false;}
}
export function trustedResearchCoordinates(data:Record<string,any>,sourceURLs:readonly string[]):boolean {
  const proof=coordinateProvenanceSchema.safeParse(data.coordinateProvenance);
  return proof.success&&sourceURLs.includes(proof.data.sourceURL)&&validResearchCoordinateSource(data.coordinateSource,proof.data.sourceURL,proof.data.method)&&
    (data.coordinateKind==='poi'||(data.coordinateSource==='Wikidata'&&data.coordinateKind==='coordinate_location'))&&
    typeof data.latitude==='number'&&Number.isFinite(data.latitude)&&data.latitude>=17.15&&data.latitude<=17.75&&
    typeof data.longitude==='number'&&Number.isFinite(data.longitude)&&data.longitude>=78.10&&data.longitude<=78.80;
}
export function publicHTTPURL(value:string):boolean {try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password;}catch{return false;}}
const publicURL=z.string().max(2048).refine(publicHTTPURL);
export const publicResearchPhotoSchema=z.object({
  url:publicURL.refine(s=>{try{return ['upload.wikimedia.org','thumb.wikimedia.org'].includes(new URL(s).hostname)&&new URL(s).protocol==='https:';}catch{return false;}}),
  sourceURL:publicURL.refine(s=>s.startsWith('https://commons.wikimedia.org/wiki/File:')),
  credit:z.string().min(1).max(2000),license:z.enum(['CC0','Public domain','CC BY 2.0','CC BY 3.0','CC BY 4.0','CC BY-SA 2.0','CC BY-SA 3.0','CC BY-SA 4.0']),
  licenseURL:publicURL.refine(s=>{try{return ['creativecommons.org','commons.wikimedia.org'].includes(new URL(s).hostname)&&new URL(s).protocol==='https:';}catch{return false;}}),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),width:z.number().int().positive(),height:z.number().int().positive(),checkedAt:z.string().max(64),
  venueAssociationVerified:z.literal(true),archival:z.boolean(),
}).strict();
