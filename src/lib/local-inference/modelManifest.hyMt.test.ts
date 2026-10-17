import { describe, it, expect } from 'vitest';
import {
  getManifestEntry,
  getManifestByType,
  getTranslationModel,
  pickBestModel,
  compareAsrModelsForLanguage,
  asrPreferenceScore,
  isAsrRecommendedForLanguage,
  recommendedAsrIdsForLanguage,
  MAX_RECOMMENDED_ASR,
  type ModelManifestEntry,
} from './modelManifest';

describe('HY-MT1.5-1.8B manifest entry', () => {
  const entry = getManifestEntry('hy-mt15-1.8b-translation');

  it('exists in the manifest', () => {
    expect(entry).toBeDefined();
  });

  it('is a multilingual WebGPU translation model with hfModelId pointing at onnx-community', () => {
    expect(entry?.type).toBe('translation');
    expect(entry?.multilingual).toBe(true);
    expect(entry?.requiredDevice).toBe('webgpu');
    expect(entry?.hfModelId).toBe('onnx-community/HY-MT1.5-1.8B-ONNX');
    expect(entry?.translationWorkerType).toBe('hy-mt');
  });

  it('declares all 36 languages from the ONNX repo README', () => {
    const expected = [
      'zh', 'en', 'fr', 'pt', 'es', 'ja', 'tr', 'ru', 'ar', 'ko',
      'th', 'it', 'de', 'vi', 'ms', 'id', 'tl', 'hi', 'pl', 'cs',
      'nl', 'km', 'my', 'fa', 'gu', 'ur', 'te', 'mr', 'he', 'bn',
      'ta', 'uk', 'bo', 'kk', 'mn', 'ug',
    ];
    expect(entry?.languages).toEqual(expected);
    expect(entry?.languages.length).toBe(36);
  });

  it('exposes q4 and q4f16 variants with correct file lists', () => {
    const q4 = entry?.variants['q4'];
    const q4f16 = entry?.variants['q4f16'];
    expect(q4?.dtype).toBe('q4');
    expect(q4f16?.dtype).toBe('q4f16');
    expect(q4f16?.requiredFeatures).toEqual(['shader-f16']);

    // 5 shared metadata files + 2 onnx files per variant
    expect(q4?.files.length).toBe(7);
    expect(q4f16?.files.length).toBe(7);

    const q4Names = q4?.files.map(f => f.filename) ?? [];
    expect(q4Names).toContain('onnx/model_q4.onnx');
    expect(q4Names).toContain('onnx/model_q4.onnx_data');
    expect(q4Names).toContain('tokenizer.json');
    expect(q4Names).toContain('chat_template.jinja');

    const q4f16Names = q4f16?.files.map(f => f.filename) ?? [];
    expect(q4f16Names).toContain('onnx/model_q4f16.onnx');
    expect(q4f16Names).toContain('onnx/model_q4f16.onnx_data');
  });

  it('is marked recommended with sortOrder 3 (best local after Bing/Google/DeepL)', () => {
    expect(entry?.recommended).toBe(true);
    expect(entry?.sortOrder).toBe(3);
  });
});

describe('Translation model sortOrder (online first, then local)', () => {
  it('puts Bing, Google, DeepL at sortOrder 0/1/2', () => {
    expect(getManifestEntry('bing-translator')?.sortOrder).toBe(0);
    expect(getManifestEntry('google-translator')?.sortOrder).toBe(1);
    expect(getManifestEntry('deepl-translator')?.sortOrder).toBe(2);
    expect(getManifestEntry('bing-translator')?.recommended).toBe(true);
    expect(getManifestEntry('google-translator')?.recommended).toBe(true);
    expect(getManifestEntry('deepl-translator')?.recommended).toBe(true);
  });

  it('ranks local multilingual after online translators', () => {
    expect(getManifestEntry('hy-mt15-1.8b-translation')?.sortOrder).toBe(3);
    expect(getManifestEntry('translategemma-4b-translation')?.sortOrder).toBe(4);
    expect(getManifestEntry('qwen3-0.6b-translation')?.sortOrder).toBe(4);
  });
});

describe('pickBestModel preference', () => {
  it('selects Bing over Google/DeepL and local models when all are recommended', () => {
    const bing = getManifestEntry('bing-translator') as ModelManifestEntry;
    const google = getManifestEntry('google-translator') as ModelManifestEntry;
    const deepl = getManifestEntry('deepl-translator') as ModelManifestEntry;
    const hy = getManifestEntry('hy-mt15-1.8b-translation') as ModelManifestEntry;
    const tg = getManifestEntry('translategemma-4b-translation') as ModelManifestEntry;
    const q = getManifestEntry('qwen3-0.6b-translation') as ModelManifestEntry;
    expect(pickBestModel([tg, q, hy, deepl, google, bing])?.id).toBe('bing-translator');
    expect(pickBestModel([hy, google, deepl])?.id).toBe('google-translator');
    expect(pickBestModel([hy, deepl])?.id).toBe('deepl-translator');
    expect(pickBestModel([tg, q, hy])?.id).toBe('hy-mt15-1.8b-translation');
  });
});

describe('getTranslationModel ranking', () => {
  it('returns Bing for ja→zh when online translators are compatible', () => {
    expect(getTranslationModel('ja', 'zh')?.id).toBe('bing-translator');
  });

  it('returns Bing for en→zh', () => {
    expect(getTranslationModel('en', 'zh')?.id).toBe('bing-translator');
  });
});

describe('ASR language preference', () => {
  it('ranks moonshine-base-ja ahead of generic recommended models for Japanese', () => {
    const moonshineJa = getManifestEntry('moonshine-base-ja-quant') as ModelManifestEntry;
    const sensevoice = getManifestEntry('sensevoice-int8') as ModelManifestEntry;
    const cohere = getManifestEntry('cohere-transcribe-webgpu') as ModelManifestEntry;
    expect(compareAsrModelsForLanguage(moonshineJa, cohere, 'ja')).toBeLessThan(0);
    expect(compareAsrModelsForLanguage(moonshineJa, sensevoice, 'ja')).toBeLessThan(0);
    expect(asrPreferenceScore(moonshineJa, 'ja')).toBeLessThan(asrPreferenceScore(sensevoice, 'ja'));
  });

  it('ranks sensevoice first for Chinese', () => {
    const sensevoice = getManifestEntry('sensevoice-int8') as ModelManifestEntry;
    const moonshineZh = getManifestEntry('moonshine-base-zh-quant') as ModelManifestEntry;
    expect(compareAsrModelsForLanguage(sensevoice, moonshineZh, 'zh')).toBeLessThan(0);
  });

  it('pickBestModel uses sourceLanguage for ASR ranking', () => {
    const moonshineJa = getManifestEntry('moonshine-base-ja-quant') as ModelManifestEntry;
    const cohere = getManifestEntry('cohere-transcribe-webgpu') as ModelManifestEntry;
    expect(pickBestModel([cohere, moonshineJa], { sourceLanguage: 'ja' })?.id)
      .toBe('moonshine-base-ja-quant');
  });

  it('caps Recommended ASR badges at three per source language', () => {
    const zh = [...getManifestByType('asr'), ...getManifestByType('asr-stream')]
      .filter((m) => m.multilingual || m.languages.includes('zh'));
    const rec = recommendedAsrIdsForLanguage(zh, 'zh');
    expect(rec.size).toBe(MAX_RECOMMENDED_ASR);
    expect(rec.has('sensevoice-int8')).toBe(true);
    expect(isAsrRecommendedForLanguage(getManifestEntry('sensevoice-int8')!, 'zh')).toBe(true);
    expect(isAsrRecommendedForLanguage(getManifestEntry('dolphin-base-int8')!, 'zh')).toBe(false);
  });
});
