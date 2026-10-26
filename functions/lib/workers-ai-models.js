import { validateOpaqueText } from './validators';

export const DEFAULT_WORKERS_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';

export function normalizeWorkersAiModel(model) {
  const value = String(model ?? '').trim();
  if (!value) return '';
  if (!validateOpaqueText(value, 200).ok) return '';
  if (!value.startsWith('@cf/')) return '';
  return value;
}

export function resolveWorkersAiModel(...candidates) {
  for (const candidate of candidates) {
    const model = normalizeWorkersAiModel(candidate);
    if (model) return model;
  }
  return DEFAULT_WORKERS_AI_MODEL;
}
