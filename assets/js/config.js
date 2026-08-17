/**
 * config.js — resolves runtime settings.
 *
 * Precedence, highest first:
 *   1. what the user typed into Settings (localStorage, this browser only)
 *   2. what the deploy workflow baked into config.generated.js (repo secrets)
 *   3. built-in defaults
 */

const LS_KEY = 'codefort.settings.v1';

const baked = (typeof window !== 'undefined' && window.__CODEFORT_CONFIG__) || {};

export const DEFAULTS = {
  mistralKey: '',
  supabaseUrl: '',
  supabaseKey: '',
  models: {
    architect: 'mistral-large-latest',
    builder: 'mistral-medium-latest',
    scout: 'mistral-small-latest'
  },
  maxRounds: 8,
  maxStepsPerTurn: 8,
  temperature: 0.35
};

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeStore(obj) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}

/** Full effective settings object. */
export function getSettings() {
  const saved = readStore();
  return {
    ...DEFAULTS,
    ...saved,
    mistralKey: saved.mistralKey || baked.mistralKey || '',
    supabaseUrl: saved.supabaseUrl || baked.supabaseUrl || '',
    supabaseKey: saved.supabaseKey || baked.supabaseKey || '',
    models: { ...DEFAULTS.models, ...(saved.models || {}) }
  };
}

/** Merge a patch into the user's stored settings. */
export function saveSettings(patch) {
  const saved = readStore();
  const next = { ...saved, ...patch };
  if (patch.models) next.models = { ...(saved.models || {}), ...patch.models };

  // Don't persist a value identical to the baked-in one — keeps the store
  // clean so a later deploy with a rotated secret takes effect.
  for (const k of ['mistralKey', 'supabaseUrl', 'supabaseKey']) {
    if (next[k] && next[k] === baked[k]) delete next[k];
    if (next[k] === '') delete next[k];
  }
  writeStore(next);
  return getSettings();
}

/** Which source a credential came from — used for the Settings hint text. */
export function credentialSource(field) {
  const saved = readStore();
  if (saved[field]) return 'browser';
  if (baked[field]) return 'deploy';
  return 'none';
}

/** Build metadata stamped in by the deploy workflow. */
export const buildInfo = {
  builtAt: baked.builtAt || '',
  commit: baked.commit || ''
};
