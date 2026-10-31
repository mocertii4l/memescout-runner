// Copy the desk's history (logs/data) into backups/<timestamp>/. Safe to run while the desk is running.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.DESK_LOG_DIR || fileURLToPath(new URL('../logs/data/', import.meta.url));
const root = fileURLToPath(new URL('../backups/', import.meta.url));
if (!existsSync(src)) { console.log(`nothing to back up: ${src} does not exist yet`); process.exit(0); }
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = join(root, stamp);
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
const files = readdirSync(dest).length;
console.log(`backed up ${files} files → ${dest}`);
console.log('Tip: copy the backups folder to a USB stick or cloud drive now and then.');
