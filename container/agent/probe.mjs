import { accessSync, constants } from 'node:fs';
import { PATHS } from './paths.mjs';

/**
 * Readiness probe, run through `exec` after the container starts: the interception CA must be
 * readable (egress is configured) and the image's tools must be executable. Exit 0 when ready.
 */
try {
  accessSync(PATHS.cloudflareCa, constants.R_OK);
  for (const tool of [PATHS.tofu, PATHS.conftest, PATHS.gh]) accessSync(tool, constants.X_OK);
  process.stdout.write('{"ready":true}\n');
} catch {
  process.exitCode = 1;
}
