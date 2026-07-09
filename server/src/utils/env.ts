import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const candidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../.env'),
];

for (const p of candidates) {
  if (existsSync(p)) {
    config({ path: p, override: true });
    console.log(`Loaded .env from ${p}`);
    break;
  }
}
