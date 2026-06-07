// ⚡ MUST be the first import in index.ts
import { config } from 'dotenv';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

const candidates = [
  join(process.cwd(), '.env'),
  join(__dirname, '..', '.env'),
  resolve(__dirname, '../../.env'),
];

let loaded = false;
for (const p of candidates) {
  if (existsSync(p)) {
    const { error } = config({ path: p, override: false });
    if (!error) { console.log(`[env-loader] Loaded ${p}`); loaded = true; break; }
  }
}
if (!loaded) config({ override: false }); // last-resort default search
