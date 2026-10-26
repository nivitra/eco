import {z} from 'zod';
import {isIP} from 'node:net';
import registryData from '../../data/official-contact-registry.json' with {type:'json'};
import {merchantProfileSchema} from './business-profile.js';

/** These links are displayed only after a user tap. Projection never fetches URLs.
 * DNS/rebinding controls remain the responsibility of safe-fetch if a future
 * offline verification job performs HTTP requests; this is not a fetch validator.
 */
export function contactHTTPSURL(value:string):boolean {
  try {
    const url=new URL(value);
    return value===value.trim()&&!/[\u0000-\u0020\u007f\\]/.test(value)&&url.protocol==='https:'&&
      !url.username&&!url.password&&!url.port&&!url.hash&&!isIP(url.hostname.replace(/^\[|\]$/g,''))&&
      !url.hostname.endsWith('.')&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)&&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|home|lan)$/i.test(url.hostname)&&
      !/(?:^|\.)localhost(?:\.|$)/i.test(url.hostname)&&value.length<=2048;
  } catch{return false;}
}
function originOf(value:string):string|undefined {try{return new URL(value).origin;}catch{return undefined;}}
const url=z.string().min(1).max(2048).refine(contactHTTPSURL,'Contact links must be public HTTPS URLs without credentials, IP hosts or fragments.');
const cleanText=(max:number)=>z.string().trim().min(1).max(max).refine(text=>!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text),'Use plain text.');
export const contactDetailsSchema=z.object({
  schemaVersion:z.literal(1),checkedAt:z.iso.datetime({offset:true}),authority:z.enum(['official_website','published_business']),
  website:z.object({url,sourceURL:url,scope:z.enum(['venue','organization'])}).strict().optional(),
  phone:z.object({number:z.string().regex(/^\+[1-9][0-9]{7,14}$/),sourceURL:url,scope:z.enum(['venue','central']),label:cleanText(80).optional()}).strict().optional(),
  hours:z.object({text:cleanText(700),sourceURL:url}).strict().optional(),
}).strict().refine(value=>!!(value.website||value.phone||value.hours),'Contact details require at least one sourced field.');
export type ContactDetails=z.infer<typeof contactDetailsSchema>;
export const officialContactRecordSchema=z.object({
  placeID:z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),expectedName:cleanText(240),expectedCategory:cleanText(60),
  officialOrigins:z.array(url.refine(value=>originOf(value)===value,'Use an exact HTTPS origin.')).min(1).max(8)
    .refine(values=>new Set(values).size===values.length,'Official origins must be unique.'),
  contactDetails:contactDetailsSchema,
}).strict().superRefine((record,context)=>{
  if(record.contactDetails.authority!=='official_website')context.addIssue({code:'custom',path:['contactDetails','authority'],message:'Editorial registry entries must identify an official website source.'});
  const details=record.contactDetails;
  const links=[details.website?.url,details.website?.sourceURL,details.phone?.sourceURL,details.hours?.sourceURL].filter((value):value is string=>!!value);
  if(links.some(value=>!record.officialOrigins.includes(originOf(value)??'')))context.addIssue({code:'custom',message:'Every contact field must cite a reviewed official origin.'});
});
export const officialContactRegistrySchema=z.object({
  schemaVersion:z.literal(1),records:z.array(officialContactRecordSchema).max(2000)
    .refine(values=>new Set(values.map(record=>record.placeID)).size===values.length,'Contact place IDs must be unique.'),
}).strict();
export type OfficialContactRecord=z.infer<typeof officialContactRecordSchema>;
export const officialContactRegistry=officialContactRegistrySchema.parse(registryData);
const registryByID=new Map(officialContactRegistry.records.map(record=>[record.placeID,record]));

/** Catalog and detail queries select only this active public projection. No
 * merchant draft, claim evidence or unwithdrawn historical catalogue copy is read.
 */
export const publicContactProjectionSQL=`(SELECT jsonb_build_object('profile',contact_page.snapshot->'profile',
 'ownerConfirmedAt',contact_page.snapshot->>'ownerConfirmedAt','publishedAt',contact_page.published_at,'canonicalPath',contact_page.canonical_path)
 FROM public_pages contact_page WHERE contact_page.place_id=places.id AND contact_page.withdrawn_at IS NULL) AS public_contact_snapshot`;

function usableDate(value:unknown,now:number):value is string {
  return typeof value==='string'&&z.iso.datetime({offset:true}).safeParse(value).success&&Date.parse(value)<=now+300_000;
}
function publishedContactDetails(snapshot:unknown,origin:string,now:number):ContactDetails|null {
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return null;
  const value=snapshot as Record<string,unknown>;
  const parsed=merchantProfileSchema.safeParse(value.profile);if(!parsed.success)return null;
  const profile=parsed.data;
  if(['temporarily_closed','permanently_closed'].includes(profile.status??''))return null;
  const checkedAt=usableDate(value.ownerConfirmedAt,now)?value.ownerConfirmedAt:usableDate(value.publishedAt,now)?value.publishedAt:undefined;
  if(!checkedAt||typeof value.canonicalPath!=='string'||!/^\/[a-z0-9]+(?:-[a-z0-9]+)*\/places\/[a-z0-9][a-z0-9-]{0,199}$/.test(value.canonicalPath))return null;
  let sourceURL:string;try{const base=new URL(origin);if(base.origin!==origin||!contactHTTPSURL(origin))return null;sourceURL=base.origin+value.canonicalPath;}catch{return null;}
  const details:ContactDetails={schemaVersion:1,authority:'published_business',checkedAt};
  if(profile.website&&contactHTTPSURL(profile.website))details.website={url:profile.website,sourceURL,scope:'venue'};
  if(profile.phone)details.phone={number:profile.phone,sourceURL,scope:'venue'};
  if(profile.hoursText&&cleanText(700).safeParse(profile.hoursText).success)details.hours={text:profile.hoursText,sourceURL};
  const checked=contactDetailsSchema.safeParse(details);return checked.success?checked.data:null;
}

/** Never merge research fields into an owner-approved profile. In particular,
 * explicit null/absence means no field, and withdrawal cannot revive old contact
 * values left in catalog_data by an earlier publication or imported registry.
 */
export function projectPlaceContact(row:Record<string,any>,publicOrigin:string,options:{records?:readonly OfficialContactRecord[];now?:number}={}):ContactDetails|null {
  const now=options.now??Date.now();
  if(row.consumer_eligible===false||!['research','published'].includes(row.state)||
    /\b(demo|fictional|synthetic)\b/i.test([row.name,row.summary,...(Array.isArray(row.tags)?row.tags:[])].join(' ')))return null;
  if(row.public_contact_snapshot!==undefined&&row.public_contact_snapshot!==null)return publishedContactDetails(row.public_contact_snapshot,publicOrigin,now);
  if(row.state!=='research'||row.catalog_data?.merchantMaintained===true)return null;
  const record=options.records?.find(item=>item.placeID===row.id)??(options.records===undefined?registryByID.get(row.id):undefined);
  const checked=officialContactRecordSchema.safeParse(record);if(!checked.success)return null;
  if(checked.data.expectedName!==row.name||checked.data.expectedCategory!==row.category||!usableDate(checked.data.contactDetails.checkedAt,now))return null;
  return structuredClone(checked.data.contactDetails);
}

/** A second boundary protects provider context from arbitrary row/private fields.
 * These are dated source statements, never an appointment or current opening claim.
 */
export function contactAIContext(value:unknown):ContactDetails|null {
  const parsed=contactDetailsSchema.safeParse(value);return parsed.success?parsed.data:null;
}
