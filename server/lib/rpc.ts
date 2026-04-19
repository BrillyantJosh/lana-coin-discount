/**
 * LanaCoin RPC Client
 * Connects to the staking wallet daemon for transaction verification
 */

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:5706';
const RPC_USER = process.env.RPC_USER || '';
const RPC_PASS = process.env.RPC_PASS || '';

interface RpcResponse {
  result: any;
  error: { code: number; message: string } | null;
  id: string;
}

/**
 * Make a JSON-RPC 1.0 call to the LanaCoin daemon
 */
export async function rpcCall(method: string, params: any[] = [], timeoutMs = 10000): Promise<any> {
  if (!RPC_USER || !RPC_PASS) {
    throw new Error('RPC credentials not configured (RPC_USER, RPC_PASS)');
  }

  // AbortController + timeout — prevent fetch from hanging forever on a stalled RPC daemon
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64'),
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: `lana-discount-${Date.now()}`,
        method,
        params,
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error(`RPC timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  // LanaCoin RPC returns HTTP 500 for RPC-level errors (e.g. TX not found)
  // Always try to parse JSON response body
  let data: RpcResponse;
  try {
    data = await res.json();
  } catch {
    throw new Error(`RPC HTTP error: ${res.status} ${res.statusText} (non-JSON response)`);
  }

  if (data.error) {
    throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
  }

  return data.result;
}

/**
 * Verify a transaction by its hash
 * Returns confirmation status, number of confirmations, and received amount
 */
export async function verifyTransaction(txHash: string): Promise<{
  confirmed: boolean;
  confirmations: number;
  amount: number;
  blockHash?: string;
}> {
  try {
    const tx = await rpcCall('gettransaction', [txHash]);

    return {
      confirmed: tx.confirmations >= 1,
      confirmations: tx.confirmations || 0,
      amount: Math.abs(tx.amount || 0),
      blockHash: tx.blockhash,
    };
  } catch (error: any) {
    // RPC error -5: "Invalid or non-wallet transaction id"
    // This means the TX was not received by our wallet
    if (error.message?.includes('-5') || error.message?.includes('Invalid or non-wallet')) {
      return { confirmed: false, confirmations: 0, amount: 0 };
    }
    throw error;
  }
}

/**
 * Check if RPC is reachable
 */
export async function checkRpcConnection(): Promise<{ connected: boolean; blockHeight?: number; error?: string }> {
  try {
    const blockCount = await rpcCall('getblockcount');
    return { connected: true, blockHeight: blockCount };
  } catch (error: any) {
    return { connected: false, error: error.message };
  }
}
