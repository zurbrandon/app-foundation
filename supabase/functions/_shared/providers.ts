// App Foundation — provider adapters.
//
// Each adapter maps the normalised GatewayInput onto one provider's wire
// format and maps the response back to token counts plus text. Adding a
// provider means adding a function here and a row in
// `foundation.ai_operations` — no app change.
//
// Adapters never read environment variables; the key is passed in. That keeps
// them pure enough to test and keeps secret handling in one place.

import type { Provider, ProviderCall, ProviderResult } from './types.ts';

/** Shared by both adapters: fail loudly rather than return a half-result. */
async function readJson(response: Response, provider: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${provider} ${response.status}: ${body.slice(0, 300)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OpenAI — chat completions.
// ---------------------------------------------------------------------------
export const openai: Provider = async (call: ProviderCall, apiKey: string): Promise<ProviderResult> => {
  const content: Record<string, unknown>[] = [];

  // Images before text: both providers attend better that way round.
  if (call.input.image) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${call.input.image.mediaType};base64,${call.input.image.base64}`,
      },
    });
  }
  if (call.input.text) {
    content.push({ type: 'text', text: call.input.text });
  }

  const messages: Record<string, unknown>[] = [];
  if (call.input.system) messages.push({ role: 'system', content: call.input.system });
  messages.push({ role: 'user', content });

  const body: Record<string, unknown> = {
    model: call.model,
    messages,
    max_completion_tokens: call.maxOutputTokens,
    ...call.params,
  };

  if (call.input.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: call.input.jsonSchema.name,
        schema: call.input.jsonSchema.schema,
        strict: true,
      },
    };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: call.signal,
  });

  const json = await readJson(response, 'openai');
  const choice = (json.choices as { message?: { content?: string } }[] | undefined)?.[0];
  const usage = (json.usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };

  return {
    text: choice?.message?.content ?? '',
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
};

// ---------------------------------------------------------------------------
// Anthropic — messages.
// ---------------------------------------------------------------------------
export const anthropic: Provider = async (call: ProviderCall, apiKey: string): Promise<ProviderResult> => {
  const content: Record<string, unknown>[] = [];

  if (call.input.image) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: call.input.image.mediaType,
        data: call.input.image.base64,
      },
    });
  }
  if (call.input.text) {
    content.push({ type: 'text', text: call.input.text });
  }

  const body: Record<string, unknown> = {
    model: call.model,
    max_tokens: call.maxOutputTokens,
    messages: [{ role: 'user', content }],
    ...call.params,
  };

  if (call.input.system) body.system = call.input.system;

  if (call.input.jsonSchema) {
    body.output_config = {
      format: {
        type: 'json_schema',
        schema: call.input.jsonSchema.schema,
      },
    };
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: call.signal,
  });

  const json = await readJson(response, 'anthropic');
  const blocks = (json.content ?? []) as { type: string; text?: string }[];
  const usage = (json.usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };

  return {
    text: blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join(''),
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
  };
};

export const providers: Record<string, Provider> = { openai, anthropic };
