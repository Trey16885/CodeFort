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

/**
 * Settings a visitor is allowed to set for themselves. Everything else —
 * the agent lineup and the Supabase project — belongs to the deployment and
 * comes from the repository secrets, not from whoever opened the page.
 */
const USER_EDITABLE = new Set(['mistralKey', 'maxRounds', 'maxStepsPerTurn', 'temperature']);

/** Full effective settings object. */
export function getSettings() {
  const saved = readStore();
  return {
    ...DEFAULTS,
    ...saved,
    mistralKey: saved.mistralKey || baked.mistralKey || '',
    supabaseUrl: baked.supabaseUrl || '',
    supabaseKey: baked.supabaseKey || '',
    models: { ...DEFAULTS.models }
  };
}

/** Merge a patch into the user's stored settings. Non-editable keys are dropped. */
export function saveSettings(patch) {
  const next = { ...readStore() };

  for (const [key, value] of Object.entries(patch || {})) {
    if (!USER_EDITABLE.has(key)) continue;
    next[key] = value;
  }

  // Don't persist a key identical to the baked-in one — keeps the store clean
  // so a later deploy with a rotated secret takes effect.
  if (!next.mistralKey || next.mistralKey === baked.mistralKey) delete next.mistralKey;

  writeStore(next);
  return getSettings();
}

/**
 * Drop settings written by older builds that let visitors override the model
 * lineup and the Supabase project. They are no longer read; this stops them
 * lingering in storage as a confusing artefact.
 */
function pruneLegacy() {
  const saved = readStore();
  const stale = ['models', 'supabaseUrl', 'supabaseKey'].filter((k) => k in saved);
  if (!stale.length) return;
  for (const k of stale) delete saved[k];
  writeStore(saved);
}

pruneLegacy();

/**
 * Where the Mistral key came from — used for the Settings hint text.
 * @returns {'browser'|'deploy'|'none'}
 */
export function credentialSource(field = 'mistralKey') {
  if (field === 'mistralKey' && readStore().mistralKey) return 'browser';
  return baked[field] ? 'deploy' : 'none';
}

/** Build metadata stamped in by the deploy workflow. */
export const buildInfo = {
  builtAt: baked.builtAt || '',
  commit: baked.commit || ''
};
