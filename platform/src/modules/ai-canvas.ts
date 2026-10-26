import {z} from 'zod';

/** The model can select a presentation, never executable UI or action URLs. */
export const canvasSchema=z.object({
  version:z.literal(1),
  layout:z.enum(['collection','spotlight','comparison']),
  title:z.string().trim().min(1).max(80).refine(value=>value.length<=80),
  focusPlaceID:z.string().min(1).max(160).optional(),
  refinements:z.array(z.enum(['narrow','alternatives','checks'])).max(3)
    .refine(values=>new Set(values).size===values.length),
}).strict();
export type AskCanvas=z.infer<typeof canvasSchema>;

export function canvasMatchesRecommendations(canvas:AskCanvas,ids:readonly string[]):boolean {
  if(!ids.length)return false;
  if(canvas.layout==='comparison'&&ids.length<2)return false;
  if(canvas.layout==='spotlight')return Boolean(canvas.focusPlaceID&&ids.includes(canvas.focusPlaceID));
  return canvas.focusPlaceID===undefined;
}

export const CANVAS_SYSTEM=`This client supports canvas version 1. Alongside answer, recommendations and followUp, you may include "canvas":{"version":1,"layout":"collection"|"spotlight"|"comparison","title":string,"focusPlaceID"?:string,"refinements":["narrow"|"alternatives"|"checks"]}. Choose a layout to serve the user's task: comparison for choosing between at least two recommendations, spotlight for one focused pick, collection for browsing several. A spotlight focusPlaceID MUST be one of this response's recommendation IDs; other layouts MUST omit focusPlaceID. Omit canvas when recommendations are empty or a server plan is provided. Title is plain text, max80 characters, with no invented claims, ratings, urgency or rankings. Refinements are unique enum values, max3. The client owns their labels and behavior, and always requires the user to send a refinement. Never generate code, URLs, purchase controls, booking confirmations, additional place records or routes. Canvas changes presentation only: all existing sourcing, constraints, exact-ID and safety rules still apply.`;
