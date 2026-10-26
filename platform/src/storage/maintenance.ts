import { recoverPrivateMedia } from '../modules/retention.js';
/** Private upload recovery honors legal holds and journals deletion before touching storage.
 * Public-approved or building-referenced media require a separate reviewed removal process. */
export const maintainMedia = recoverPrivateMedia;
