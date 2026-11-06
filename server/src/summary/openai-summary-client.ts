import OpenAI from 'openai';
import { buildUserMessage, SYSTEM_PROMPT } from './prompt.js';
import {
  PermanentSummaryError,
  RateLimitedSummaryError,
  type SummaryClient,
  type SummaryInput,
} from './summary-client.js';

/** The request itself is wrong; sending it again gets the same answer. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

export interface OpenAiSummaryClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Speaks the OpenAI Chat Completions API, so one client covers the provided mock server
 * (the configured default), OpenAI, Ollama and other compatible endpoints.
 */
export class OpenAiSummaryClient implements SummaryClient {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiSummaryClientOptions) {
    this.client = new OpenAI({
      baseURL: options.baseUrl,
      apiKey: options.apiKey,
      // The worker owns retries and timeouts; SDK retries would multiply billed calls.
      maxRetries: 0,
    });
  }

  async summarize(input: SummaryInput, signal: AbortSignal): Promise<string> {
    let completion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: this.options.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserMessage(input) },
          ],
          max_tokens: 120,
          temperature: 0.2,
        },
        { signal },
      );
    } catch (err) {
      throw classify(err);
    }
    const text = completion.choices[0]?.message.content?.trim();
    if (!text) throw new Error('LLM returned an empty summary');
    return text;
  }
}

function classify(err: unknown): unknown {
  if (!(err instanceof OpenAI.APIError)) return err;
  if (err.status !== undefined && PERMANENT_STATUSES.has(err.status)) {
    return new PermanentSummaryError(err.message, { cause: err });
  }
  const retryAfterMs = parseRetryAfter(err.headers?.get('retry-after') ?? null);
  return retryAfterMs === undefined ? err : new RateLimitedSummaryError(err.message, retryAfterMs, { cause: err });
}

/** Retry-After is either a number of seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
