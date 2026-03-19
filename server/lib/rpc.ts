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
export async function rpcCall(method: string, params: any[] = []): Promise<any> {
  if (!RPC_USER || !RPC_PASS) {
    throw new Error('RPC credentials not configured (RPC_USER, RPC_PASS)');
  }

  const res = await fetch(RPC_URL, {
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
  });

  if (!res.ok) {
    throw new Error(`RPC HTTP error: ${res.status} ${res.statusText}`);
  }

  const data: RpcResponse = await res.json();

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
    // TX not found in wallet = not received
    if (error.message?.includes('-5')) {
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
