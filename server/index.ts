import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api.js';
import { fetchKind38888 } from './lib/nostr.js';
import db from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json());

// API routes
app.use('/api', apiRouter);
app.use('/health', (_req, res) => res.redirect('/api/health'));

// Serve static frontend in production
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[lana-discount] Server running on port ${PORT}`);

  // Initial KIND 38888 sync
  try {
    const { relays, rawEvent } = await fetchKind38888();
    if (rawEvent) {
      db.prepare(`
        INSERT OR IGNORE INTO kind_38888 (event_id, pubkey, relays, raw_event)
        VALUES (?, ?, ?, ?)
      `).run(rawEvent.id, rawEvent.pubkey, JSON.stringify(relays), JSON.stringify(rawEvent));
      console.log(`[lana-discount] KIND 38888 synced, ${relays.length} relays`);
    }
  } catch (e) {
    console.error('[lana-discount] KIND 38888 initial sync failed:', e);
  }
});
