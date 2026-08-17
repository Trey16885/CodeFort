/**
 * build-config.mjs — writes assets/js/config.generated.js at deploy time.
 *
 * Reads KEY_TOKEN / SUP_URL / SUP_PB from the environment (the workflow maps
 * the repository secrets in) and emits a plain script that sets
 * window.__CODEFORT_CONFIG__ before the app modules load.
 *
 * Everything written here is served to every visitor of the Pages site. That
 * is deliberate for SUP_PB (a publishable key, guarded by row-level security)
 * and is a real exposure for KEY_TOKEN — see docs/SECURITY.md.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('assets/js/config.generated.js');

const value = (name) => (process.env[name] || '').trim();

const config = {
  mistralKey: value('KEY_TOKEN'),
  supabaseUrl: value('SUP_URL').replace(/\/+$/, ''),
  supabaseKey: value('SUP_PB'),
  builtAt: new Date().toISOString(),
  commit: value('COMMIT')
};

for (const [key, val] of Object.entries(config)) {
  if (typeof val === 'string' && /["\\\n\r<]/.test(val)) {
    throw new Error(`${key} contains a character that cannot be embedded safely`);
  }
}

if (!config.mistralKey) {
  console.warn('warning: KEY_TOKEN is empty — the deployed site will ask visitors for their own key.');
}
if (!config.supabaseUrl || !config.supabaseKey) {
  console.warn('warning: SUP_URL / SUP_PB are empty — publishing and published-site viewing will be disabled.');
}

const banner = `/* GENERATED AT DEPLOY TIME — do not edit, do not commit real values.
   Written by scripts/build-config.mjs from the repository secrets. */`;

writeFileSync(
  OUT,
  `${banner}\nwindow.__CODEFORT_CONFIG__ = ${JSON.stringify(config, null, 2)};\n`,
  'utf8'
);

console.log(`wrote ${OUT}`);
