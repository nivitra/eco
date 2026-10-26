import type { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { consumeQuota, HttpError, query } from '../db.js';
import { boundedJSON } from './ai.js';

const coordinate=z.object({latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180)}).strict();
const requestSchema=z.object({origin:coordinate,destinationPlaceID:z.string().min(1).max(160),mode:z.enum(['driving','walking']).default('driving')}).strict();
type Point=z.infer<typeof coordinate>;
export function metres(a:Point,b:Point):number {const rad=Math.PI/180;const dlat=(b.latitude-a.latitude)*rad,dlon=(b.longitude-a.longitude)*rad;const h=Math.sin(dlat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dlon/2)**2;return 12742000*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));}
function fail():never {throw new HttpError(502,'invalid_route','The router returned an unusable route.');}
function point(raw:unknown):Point {if(!Array.isArray(raw)||raw.length!==2)fail();const p=coordinate.safeParse({longitude:raw[0],latitude:raw[1]});if(!p.success)fail();return p.data;}
export function parseRoute(value:any,from:Point,to:Point) {
  if(['NoRoute','NoSegment'].includes(value?.code))throw new HttpError(422,'no_route','No route was found for these endpoints.');
  if(value?.code!=='Ok'||!Array.isArray(value.waypoints)||value.waypoints.length!==2||!Array.isArray(value.routes)||!value.routes.length)fail();
  const snapped=value.waypoints.map((w:any,i:number)=>{const p=point(w.location);if(!Number.isFinite(w.distance)||w.distance<0)fail();if(w.distance>200||metres(p,[from,to][i]!)>200)throw new HttpError(422,'arrival_confirmation_required','The road is too far from a selected point. Confirm your arrival point in a maps app.');return p;});
  const route=value.routes[0];
  if(!Number.isFinite(route.distance)||route.distance<0||!Number.isFinite(route.duration)||route.duration<0||route.geometry?.type!=='LineString'||!Array.isArray(route.geometry.coordinates)||route.geometry.coordinates.length<2||route.geometry.coordinates.length>20_000)fail();
  const geometry=route.geometry.coordinates.map(point);
  if(metres(geometry[0],snapped[0])>100||metres(geometry.at(-1),snapped[1])>100)fail();
  return {distanceMetres:route.distance,durationSeconds:route.duration,geometry:{type:'LineString',coordinates:geometry.map((p:Point)=>[p.longitude,p.latitude])}};
}
export function registerRoutes(app:Hono) {
  app.post('/v1/routes',async c=>{
    const user=await requireUser(c);const input=requestSchema.parse(await c.req.json());
    if(!config.routingURL)throw new HttpError(503,'routing_not_configured','Route previews are not configured. Open your preferred maps app.');
    await consumeQuota(`routes:${user.id}`,10,60);
    const result=await query("SELECT m.payload FROM place_map_points m JOIN places p ON p.id=m.place_id WHERE p.id=$1 AND p.state NOT IN ('closed','withdrawn','merged')",[input.destinationPlaceID]);
    const source=result.rows[0]?.payload;
    if(!source||source.osmType!=='node')throw new HttpError(422,'arrival_confirmation_required','This place has no usable POI routing point. Area centers are not entrances.');
    const to=coordinate.parse({latitude:source.latitude,longitude:source.longitude});
    let url:URL;try{url=new URL(config.routingURL);}catch{throw new HttpError(503,'routing_not_configured','Route previews are not configured.');}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new HttpError(503,'routing_not_configured','Route configuration is invalid.');
    // Never automatically use the public demo service for a multi-user backend.
    if(url.hostname==='routing.openstreetmap.de')throw new HttpError(503,'routing_contract_required','Configure an operated or contracted routing service before enabling shared routing.');
    url.pathname=url.pathname.replace(/\/$/,'')+`/${input.mode==='walking'?'routed-foot':'routed-car'}/route/v1/driving/${input.origin.longitude},${input.origin.latitude};${to.longitude},${to.latitude}`;
    url.search=new URLSearchParams({overview:'full',geometries:'geojson',steps:'false',alternatives:'false'}).toString();
    let response:Response;try{response=await fetch(url,{redirect:'error',signal:AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(15_000)]),headers:{'User-Agent':'KultureServer/1.0 (explicit route preview)','Accept':'application/json'}});}catch{throw new HttpError(503,'route_timeout','The route provider could not respond.');}
    if(!response.ok){await response.body?.cancel();throw new HttpError(503,'route_provider_unavailable','The route provider is unavailable.');}
    const route=parseRoute(await boundedJSON(response,2_000_000),input.origin,to);
    c.header('Cache-Control','private, no-store');
    return c.json({...route,mode:input.mode,destinationPlaceID:input.destinationPlaceID,traffic:false,verifiedEntrance:false,provider:'Configured OSM routing service',requiredMapSurface:'compatible_open_stack',attribution:'© OpenStreetMap contributors',computedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300_000).toISOString(),warning:'Mapped POI preview only; confirm the actual entrance. No live traffic.'});
  });
}
