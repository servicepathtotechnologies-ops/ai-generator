const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiCallResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

function getApiKeys(): string[] {
  const pool = process.env.GEMINI_API_KEYS;
  if (pool) return pool.split(',').map(k => k.trim()).filter(Boolean);
  const single = process.env.GEMINI_API_KEY;
  if (single) return [single.trim()];
  return [];
}

async function callWithKey(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  model: string,
  temperature: number,
): Promise<GeminiCallResult> {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature },
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Gemini API ${response.status}: ${body}`) as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const data = await response.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usage = data.usageMetadata;

  return {
    text,
    promptTokens: usage?.promptTokenCount ?? Math.ceil(systemPrompt.length / 4),
    completionTokens: usage?.candidatesTokenCount ?? Math.ceil(text.length / 4),
  };
}

/**
 * Single-shot Gemini call with automatic key rotation on 429 (rate-limit / quota exhausted).
 * Reads GEMINI_API_KEYS (comma-separated) with GEMINI_API_KEY as fallback.
 */
export async function callGemini(
  systemPrompt: string,
  userMessage: string,
  model: string,
  temperature: number,
): Promise<GeminiCallResult> {
  const keys = getApiKeys();
  if (keys.length === 0) throw new Error('[ai-generator] No GEMINI_API_KEY configured');

  let lastError: unknown;
  for (const key of keys) {
    try {
      return await callWithKey(key, systemPrompt, userMessage, model, temperature);
    } catch (err: any) {
      lastError = err;
      if (err?.status === 429 || err?.message?.includes('429')) {
        continue; // try next key
      }
      throw err; // non-quota error — fail fast
    }
  }
  throw lastError;
}
