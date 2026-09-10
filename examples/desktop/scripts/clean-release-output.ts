import path from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

function main(): void {
  const releaseRoot = path.resolve(__dirname, '..', 'release');
  if (existsSync(releaseRoot)) {
    rmSync(releaseRoot, { recursive: true, force: true });
  }
  mkdirSync(releaseRoot, { recursive: true });
  console.log(`[clean-release-output] ready: ${releaseRoot}`);
}

main();
