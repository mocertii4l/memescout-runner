// Cross-platform "was this file run directly?" check. Comparing import.meta.url with
// `file://${process.argv[1]}` breaks on Windows (C:\ paths, file:///C:/ URLs).
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return pathToFileURL(realpathSync(process.argv[1])).href === metaUrl; }
  catch { return pathToFileURL(process.argv[1]).href === metaUrl; }
}

/** `--mode=paper` style flag, falling back to an env var, then a default. */
export function flag(name, envName, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : process.env[envName] || fallback;
}
