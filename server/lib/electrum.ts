import * as net from 'net';

export interface ElectrumServer {
  host: string;
  port: number;
}

export interface WalletBalance {
  wallet_id: string;
  balance: number;
  status: string;
  error?: string;
}

/**
 * Connect to the first available Electrum server
 */
async function connectElectrum(servers: ElectrumServer[], maxRetries = 2): Promise<net.Socket> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const server of servers) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const conn = net.connect(server.port, server.host, () => {
            console.log(`[electrum] Connected to ${server.host}:${server.port}`);
            resolve(conn);
          });
          conn.setTimeout(10000);
          conn.on('error', reject);
          conn.on('timeout', () => reject(new Error('Connection timeout')));
        });
        return socket;
      } catch (error: any) {
        console.error(`[electrum] ${server.host}:${server.port} failed:`, error.message);
      }
    }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('Failed to connect to any Electrum server');
}

/**
 * Batch fetch balances for multiple wallet addresses over a single TCP connection.
 * Converts lanoshis to LANA (÷ 100,000,000), rounds to 2 decimal places.
 */
export async function fetchBatchBalances(
  servers: ElectrumServer[],
  addresses: string[],
  connectionTimeout = 15000
): Promise<WalletBalance[]> {
  for (const server of servers) {
    try {
      console.log(`[electrum] Batch balance fetch: ${addresses.length} addresses via ${server.host}:${server.port}`);
      const result = await fetchBatchFromServer(server, addresses, connectionTimeout);
      console.log(`[electrum] Batch completed: ${result.length} balances`);
      return result;
    } catch (error: any) {
      console.warn(`[electrum] Server ${server.host}:${server.port} failed:`, error.message);
      continue;
    }
  }
  throw new Error('All Electrum servers failed');
}

async function fetchBatchFromServer(
  server: ElectrumServer,
  addresses: string[],
  timeout: number
): Promise<WalletBalance[]> {
  return new Promise(async (resolve, reject) => {
    let socket: net.Socket | null = null;
    const timer = setTimeout(() => {
      if (socket) socket.destroy();
      reject(new Error('Batch connection timeout'));
    }, timeout);

    try {
      socket = await new Promise<net.Socket>((res, rej) => {
        const conn = net.connect(server.port, server.host, () => res(conn));
        conn.setTimeout(timeout);
        conn.on('error', rej);
        conn.on('timeout', () => rej(new Error('Connection timeout')));
      });

      // Send all balance requests at once over single connection
      let requestId = 1;
      for (const address of addresses) {
        const request = {
          id: requestId++,
          method: 'blockchain.address.get_balance',
          params: [address],
        };
        socket.write(JSON.stringify(request) + '\n');
      }

      // Collect responses
      const responses = new Map<number, any>();
      let buffer = '';

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              responses.set(response.id, response);
            } catch {}
          }
        }

        if (responses.size >= addresses.length) {
          clearTimeout(timer);
          socket!.destroy();

          const LANOSHI_DIVISOR = 100000000;
          const balances: WalletBalance[] = addresses.map((address, i) => {
            const resp = responses.get(i + 1);
            if (resp && resp.result) {
              const confirmed = resp.result.confirmed || 0;
              const unconfirmed = resp.result.unconfirmed || 0;
              const totalLana = (confirmed + unconfirmed) / LANOSHI_DIVISOR;
              return {
                wallet_id: address,
                balance: Math.round(totalLana * 100) / 100,
                status: totalLana > 0 ? 'active' : 'inactive',
              };
            } else {
              return {
                wallet_id: address,
                balance: 0,
                status: 'inactive',
                error: resp?.error?.message || 'No response',
              };
            }
          });

          resolve(balances);
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    } catch (error) {
      clearTimeout(timer);
      if (socket) socket.destroy();
      reject(error);
    }
  });
}
