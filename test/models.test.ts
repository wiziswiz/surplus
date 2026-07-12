import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_MODEL_FALLBACK, codexModels, parseCodexModels } from '../src/models.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'surplus-models-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SAMPLE = JSON.stringify({
  models: [
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
    { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list' },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'list' },
    { slug: 'gpt-internal-hidden', display_name: 'Hidden', visibility: 'hidden' },
    { slug: '', display_name: 'Empty' },
  ],
});

describe('parseCodexModels', () => {
  it('keeps list-visible worker slugs and drops review-only / hidden / empty', () => {
    expect(parseCodexModels(SAMPLE)).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini']);
  });
  it('throws on malformed JSON (callers treat as failure)', () => {
    expect(() => parseCodexModels('{not json')).toThrow();
  });
});

describe('codexModels', () => {
  const cachePath = () => join(tmp, 'codex-models.json');

  it('probes the CLI, returns parsed slugs, and writes a cache', () => {
    const probe = vi.fn(() => SAMPLE);
    const models = codexModels({ dir: tmp, now: () => 1000, probe });
    expect(models).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini']);
    expect(probe).toHaveBeenCalledTimes(1);
    const cached = JSON.parse(readFileSync(cachePath(), 'utf8'));
    expect(cached).toEqual({ models, fetchedAt: 1000 });
  });

  it('serves a fresh cache without probing', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ models: ['gpt-5.6-sol'], fetchedAt: 1000 }));
    const probe = vi.fn(() => SAMPLE);
    // 1h later, well within the 12h TTL
    expect(codexModels({ dir: tmp, now: () => 1000 + 3_600_000, probe })).toEqual(['gpt-5.6-sol']);
    expect(probe).not.toHaveBeenCalled();
  });

  it('re-probes and refreshes once the cache is stale (>12h)', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ models: ['old-model'], fetchedAt: 0 }));
    const probe = vi.fn(() => SAMPLE);
    const models = codexModels({ dir: tmp, now: () => 13 * 60 * 60_000, probe });
    expect(models).toContain('gpt-5.6-sol');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale cache when the probe fails', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ models: ['stale-but-real'], fetchedAt: 0 }));
    const models = codexModels({ dir: tmp, now: () => 13 * 60 * 60_000, probe: () => null });
    expect(models).toEqual(['stale-but-real']);
  });

  it('falls back to the static list when there is no cache and the probe fails', () => {
    expect(codexModels({ dir: tmp, now: () => 1000, probe: () => null })).toEqual([
      ...CODEX_MODEL_FALLBACK,
    ]);
  });

  it('falls back to the static list when the probe returns malformed output', () => {
    expect(codexModels({ dir: tmp, now: () => 1000, probe: () => '{bad json' })).toEqual([
      ...CODEX_MODEL_FALLBACK,
    ]);
  });
});
