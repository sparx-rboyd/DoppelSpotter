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

export interface ChatCompletionOptions {
  temperature?: number;
}

/**
 * Send a chat completion request to OpenRouter.
 * Uses the model specified in OPENROUTER_MODEL env var (default: deepseek/deepseek-v3.2).
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const model = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v3.2';
  const temperature = options.temperature ?? 0.8;

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
      temperature,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data: OpenRouterResponse = await res.json();
  return data.choices[0]?.message?.content ?? '';
}
