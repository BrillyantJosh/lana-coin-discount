/**
 * THE /api RATE LIMIT: 1500 REQUESTS PER 15 MINUTES PER IP — EXCEPT FOR A
 * MACHINE CALLER THAT PRESENTS AN ACTIVE API KEY.
 *
 * Why the limit has the numbers it has, why it covers only /api, and what went
 * wrong on 7–8 Oct 2026 when the brain was held to it too, is told where it is
 * mounted, in server/index.ts. This file only holds the options, so that the
 * tests build exactly the limiter production runs.
 */
import rateLimit from 'express-rate-limit';
import { isActiveMachineKey } from './apiKeyAuth.js';

export const API_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const API_RATE_LIMIT_MAX = 1500;

/**
 * The limiter server/index.ts mounts on /api. `max` is a parameter only so a
 * test can reach the limit in three requests instead of 1,501.
 */
export function apiRateLimit(max: number = API_RATE_LIMIT_MAX) {
  return rateLimit({
    windowMs: API_RATE_LIMIT_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Not counted and never refused: a request whose Bearer ldk_ key is one
    // requireApiKey would accept. Anything else — no header, another scheme,
    // an unknown or disabled key, a database that cannot answer — is counted.
    skip: isActiveMachineKey,
  });
}
