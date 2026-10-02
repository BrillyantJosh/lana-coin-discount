/**
 * HOW MUCH JSON A REQUEST MAY CARRY, AND WHAT A REFUSAL SAYS.
 *
 * Everything is held to 50 kb (security hardening, 21 Mar 2026) — except the
 * one route whose body is a list that grows with the business.
 *
 * "Confirm Received" on /admin/incoming-payments sends the whole batch: every
 * payment in it, with its order type, amount, wallet, shop and transaction.
 * The server needs that list — it records the batch's payments, tells the
 * brain which transactions the money covered, and links the LANA orders to
 * the batch. A payment is ~250 bytes of JSON, so 50 kb is about 200 payments.
 * On 2 Oct 2026 one investor's batch held 288 (€5,435.49) and could not be
 * confirmed at all: the parser refused it before the route ran, and the page
 * said only "Failed to update batch status". Nothing showed in request_logs
 * either, because the logger sat after the parser that threw.
 *
 * So that route gets its own parser with room for ~8,000 payments, mounted
 * BEFORE the global one; body-parser skips a body that is already read, so the
 * global 50 kb parser never sees it. Every other route keeps 50 kb.
 *
 * And a body that is refused is refused in JSON, with a code, so a page can
 * say what happened instead of guessing.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { keepRawBody } from './nip98Auth.js';

export const DEFAULT_BODY_LIMIT = '50kb';
export const BATCH_BODY_LIMIT = '2mb';

/**
 * Routes whose body is a list that grows with a batch: its payments, or the
 * transactions whose LANA it sends (send-batch-lana — ~39 bytes a reference,
 * so 50 kb is ~1,250; not reached yet, but the same list on the same button).
 */
export const LARGE_BODY_PATHS = ['/api/admin/incoming-batches', '/api/admin/send-batch-lana'] as const;

export function installJsonBodies(app: Express): void {
  for (const p of LARGE_BODY_PATHS) {
    app.use(p, express.json({ limit: BATCH_BODY_LIMIT, verify: keepRawBody }));
  }
  // verify: keepRawBody keeps the exact bytes the client sent, so a signed admin
  // request's `payload` tag is checked against what arrived, not a re-serialisation.
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT, verify: keepRawBody }));
  app.use(jsonBodyErrors);
}

/**
 * body-parser's own errors, answered in JSON. Anything else is passed on
 * untouched — this is not the place to decide how a route's failures read.
 */
export function jsonBodyErrors(err: any, req: Request, res: Response, next: NextFunction): void {
  if (!err || res.headersSent) return next(err);
  if (err.type === 'entity.too.large') {
    console.warn(`[lana-discount] Body too large: ${req.method} ${String(req.originalUrl || req.url).split('?')[0]} — ${err.length ?? '?'} bytes, limit ${err.limit ?? '?'}`);
    res.status(413).json({
      code: 'BODY_TOO_LARGE',
      error: `The request was too large for the server to read (${err.length ?? '?'} bytes; the limit here is ${err.limit ?? '?'} bytes). Nothing was changed.`,
    });
    return;
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ code: 'BODY_NOT_JSON', error: 'The request body is not valid JSON. Nothing was changed.' });
    return;
  }
  next(err);
}
