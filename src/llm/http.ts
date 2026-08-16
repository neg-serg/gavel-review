/**
 * OpenAI 兼容 HTTP 客户端：供独立 CLI 使用，零第三方依赖（内置 fetch）。
 *
 * 兼容任何 OpenAI Chat Completions 协议的服务端（DeepSeek、OpenAI、
 * vLLM、Ollama 的 OpenAI 端点等），通过 GAVEL_BASE_URL / GAVEL_API_KEY 配置。
 */

import type { LlmClient } from '../core/types.ts';

/** HTTP 客户端配置。 */
export interface HttpClientConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

/** 构造 OpenAI 兼容客户端。 */
export function createHttpClient(config: HttpClientConfig): LlmClient {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = config.timeoutMs ?? 120_000;
  return {
    async complete({ system, user, maxTokens, temperature, signal }) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              { role: 'user', content: user },
            ],
            max_tokens: maxTokens,
            temperature,
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300);
          throw new Error(`模型接口 HTTP ${response.status}: ${detail}`);
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = payload.choices?.[0]?.message?.content ?? '';
        if (!text) throw new Error('模型接口返回空内容');
        return { text };
      } catch (error) {
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
        if ((error as Error).name === 'AbortError') {
          throw new Error(`模型请求超时（${timeoutMs}ms）或已取消`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
