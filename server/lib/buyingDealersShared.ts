/**
 * The one dealer reader this process keeps (./buyingDealers.ts), shared by
 * GET /api/buying-dealers and the refusal every closed sale route answers, so
 * both name the same firms from the same read. Separate from buyingDealers.ts
 * only so that module's tests never open the production database.
 *
 * `keepFresh`: from the first time it is asked, it reads again every ten
 * minutes by itself, as BEF Explorer does on its heartbeat — a refusal never
 * waits on a relay, so without this the first one after a quiet night would
 * name the firms of the evening before. The timer starts on first use, not at
 * import, and never keeps the process alive.
 */
import { getDbHandle } from '../db/index.js';
import { createBuyingDealersReader } from './buyingDealers.js';

export const buyingDealers = createBuyingDealersReader({ db: getDbHandle, keepFresh: true });
