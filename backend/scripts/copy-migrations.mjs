// Copies the Drizzle migration folder next to the compiled output so that
// `node dist/main.js` can apply migrations without the source tree.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'drizzle');
const dst = join(root, 'dist', 'drizzle');
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log('copied migrations to dist/drizzle');
