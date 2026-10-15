import 'dotenv/config';

export interface ModelProbeAttempt {
  model: string;
  ok: boolean;
  detail: string;
}

export interface ModelResolution {
  model: string | null;
  attempts: ModelProbeAttempt[];
  blockedReason?: string;
}

interface ChatCompletionClient {
  chat: {
    completions: {
      create: (args: {
        model: string;
        messages: Array<{ role: 'system' | 'user'; content: string }>;
        temperature?: number;
        max_tokens?: number;
      }) => Promise<unknown>;
    };
  };
}

const DEFAULT_MODELS = [
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1',
  'gpt-4o-mini',
  'gpt-4o',
];

let cachedResolution: Promise<ModelResolution> | null = null;
let cachedSignature = '';

export function resolveModelCandidates(): string[] {
  const raw = process.env.GITHUB_MODELS_CANDIDATES?.trim();
  const values = raw
    ? raw.split(',').map(v => v.trim()).filter(Boolean)
    : [
        process.env.GITHUB_MODELS_MODEL?.trim() || '',
        process.env.GITHUB_MODELS_FALLBACK_MODEL?.trim() || '',
        ...DEFAULT_MODELS,
      ];

  const out: string[] = [];
  for (const value of values.map(normalizeModelId).filter(Boolean)) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export function clearCachedModelResolution(): void {
  cachedResolution = null;
  cachedSignature = '';
}

export async function resolveGitHubModel(client: ChatCompletionClient): Promise<ModelResolution> {
  const candidates = resolveModelCandidates();
  if (!candidates.length) {
    return {
      model: null,
      attempts: [],
      blockedReason: 'No GitHub Models candidates configured.',
    };
  }

  const signature = candidates.join('|');
  if (!cachedResolution || cachedSignature !== signature) {
    cachedSignature = signature;
    cachedResolution = probeCandidates(client, candidates);
  }
  return cachedResolution;
}

async function probeCandidates(client: ChatCompletionClient, candidates: string[]): Promise<ModelResolution> {
  const attempts: ModelProbeAttempt[] = [];

  for (const model of candidates) {
    try {
      await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Reply with ok.' }],
        temperature: 0,
        max_tokens: 1,
      });
      attempts.push({ model, ok: true, detail: 'available' });
      return { model, attempts };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      attempts.push({ model, ok: false, detail });
    }
  }

  return {
    model: null,
    attempts,
    blockedReason: buildBlockedReason(attempts),
  };
}

function buildBlockedReason(attempts: ModelProbeAttempt[]): string {
  const summary = attempts
    .map(a => `${a.model} → ${a.detail.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
    .join('; ');
  return `No GitHub Models candidate responded with access: ${summary}`;
}

function normalizeModelId(model: string): string {
  if (!model) return '';
  if (model === 'openai/gpt-4') {
    return 'openai/gpt-4o';
  }
  return model;
}
