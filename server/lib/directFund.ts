/**
 * Where direct.lana.fund answers from inside the docker network. One
 * constant, shared by the payment proxy in routes/api.ts and the round-terms
 * prefill in routes/treasury.ts, so both point at the same host.
 */
export const DIRECT_FUND_URL = process.env.DIRECT_FUND_URL || 'http://lana-direct-fund-web:3005';
