/**
 * OpenRouter client for AI analysis.
 * OpenRouter provides a unified API compatible with the OpenAI SDK format.
 * Reference: https://openrouter.ai/docs
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterResponse {
  id: string;
  choices: {
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Send a chat completion request to OpenRouter.
 * Uses the model specified in OPENROUTER_MODEL env var (default: anthropic/claude-3.5-haiku).
 */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-3.5-haiku';

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://app.doppelspotter.com',
      'X-Title': 'DoppelSpotter',
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_tokens: 32000,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data: OpenRouterResponse = await res.json();
  return data.choices[0]?.message?.content ?? '';
}
