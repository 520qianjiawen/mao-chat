import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatibleProviderConfig } from './OpenAICompatibleProviderConfig';
import { OpenAIClient } from '../clients/OpenAIClient';

describe('OpenAICompatibleProviderConfig', () => {
  let config: OpenAICompatibleProviderConfig;

  beforeEach(() => {
    config = new OpenAICompatibleProviderConfig();
  });

  it('validates and maps models successfully even without gpt-realtime models', async () => {
    const fetchSpy = vi.spyOn(OpenAIClient, 'fetchOpenAIModelsList').mockResolvedValueOnce({
      models: [
        { id: 'Ling-3.1-flash', object: 'model', created: 1234567890, owned_by: 'ling' },
        { id: 'Ming-3.0-audio-flash', object: 'model', created: 1234567891, owned_by: 'ming' },
      ],
    });

    const res = await config.validateAndFetchModels({
      ok: true,
      primary: 'test-key',
      endpoint: 'https://api.ant-ling.com/v1',
    });

    expect(fetchSpy).toHaveBeenCalledWith('test-key', 'https://api.ant-ling.com');
    expect(res.validation.valid).toBe(true);
    expect(res.models.length).toBe(2);
    expect(res.models[0].id).toBe('Ling-3.1-flash');
    expect(res.models[1].id).toBe('Ming-3.0-audio-flash');
    expect(res.models[1].type).toBe('realtime');
  });

  it('latestRealtimeModel chooses appropriate model', () => {
    expect(config.latestRealtimeModel([
      { id: 'Ling-3.1-flash', type: 'chat', created: 1 },
      { id: 'Ming-3.0-audio-flash', type: 'realtime', created: 2 },
    ])).toBe('Ming-3.0-audio-flash');

    expect(config.latestRealtimeModel([
      { id: 'Ling-3.1-flash', type: 'chat', created: 1 },
      { id: 'custom-model', type: 'chat', created: 2 },
    ])).toBe('Ling-3.1-flash');
  });
});
