// Location of the byte fixtures that external engines wrote. Consumers read
// the files instead of regenerating them, so the bytes under `fixtures/` stay
// the single source of external truth.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixturePath(name) {
  return join(fixturesDirectory, name);
}
