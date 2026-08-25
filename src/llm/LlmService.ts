import * as vscode from "vscode";
import { SYSTEM_PROMPT, buildUserMessage, PresetId } from "../core/improvementEngine";

// ---------------------------------------------------------------------------
// Types for raw fetch-based API calls (no SDK dependency)
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChatResponse {
  choices: { message: { content: string } }[];
}

interface AnthropicResponse {
  content: { type: string; text: string }[];
}

// ---------------------------------------------------------------------------
// LlmService
// ---------------------------------------------------------------------------

export interface ImproveResult {
  improved: string;
  remaining?: number;
}

export class LlmService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Main entry point. Tries 3 tiers in order:
   *  1. VS Code built-in LM API (Copilot / any registered model)
   *  2. User's own API key (OpenAI / Anthropic / Groq / custom)
   *  3. Hosted proxy (Cloudflare Worker → Groq)
   */
  async improve(draft: string, preset: PresetId): Promise<ImproveResult> {
    const userMsg = buildUserMessage(draft, preset);

    // ── Tier 1: vscode.lm ──────────────────────────────────────────────────
    try {
      const result = await this.tryVscodeLm(userMsg);
      if (result) return { improved: result };
    } catch {
      // Not available — fall through
    }

    // ── Tier 2: User's own API key ─────────────────────────────────────────
    const apiKey = await this.context.secrets.get("promptImprover.apiKey");
    if (apiKey) {
      try {
        const result = await this.tryUserKey(apiKey, userMsg);
        if (result) return { improved: result };
      } catch (err) {
        // Key may be wrong; show a helpful error and fall through to proxy
        void vscode.window.showWarningMessage(
          `Prompt Improver: Your API key failed (${String(err)}). Falling back to free proxy.`
        );
      }
    }

    // ── Tier 3: Hosted proxy ───────────────────────────────────────────────
    return this.tryProxy(userMsg);
  }

  // ── Tier 1 ────────────────────────────────────────────────────────────────

  private async tryVscodeLm(userMsg: string): Promise<string | null> {
    // vscode.lm is only available in VS Code 1.90+; guard with typeof check
    if (!("lm" in vscode)) return null;

    const models = await (vscode as any).lm.selectChatModels({
      vendor: "copilot",
      family: "gpt-4o",
    });

    if (!models || models.length === 0) return null;

    const model = models[0];
    const messages = [
      (vscode as any).LanguageModelChatMessage.User(
        `<system>\n${SYSTEM_PROMPT}\n</system>\n\n${userMsg}`
      ),
    ];

    const tokenSource = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(messages, {}, tokenSource.token);

    let text = "";
    for await (const chunk of response.text) {
      text += chunk;
    }

    return text.trim() || null;
  }

  // ── Tier 2 ────────────────────────────────────────────────────────────────

  private async tryUserKey(apiKey: string, userMsg: string): Promise<string | null> {
    const cfg = vscode.workspace.getConfiguration("promptImprover");
    const provider = cfg.get<string>("userProvider") ?? "openai";
    const model = cfg.get<string>("userModel") || this.defaultModel(provider);
    const baseUrl =
      cfg.get<string>("userBaseUrl") ||
      this.defaultBaseUrl(provider);

    if (provider === "anthropic") {
      return this.callAnthropic(apiKey, model, userMsg);
    }

    // OpenAI-compatible (openai / groq / ollama / custom)
    return this.callOpenAICompatible(baseUrl, apiKey, model, userMsg);
  }

  private async callOpenAICompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    userMsg: string
  ): Promise<string> {
    const messages: OpenAIMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ];

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 2048 }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Empty response from API");
    return content;
  }

  private async callAnthropic(
    apiKey: string,
    model: string,
    userMsg: string
  ): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    const block = data.content?.find((b) => b.type === "text");
    if (!block?.text) throw new Error("Empty response from Anthropic");
    return block.text.trim();
  }

  /**
   * Fetches remaining daily quota from the proxy server without consuming a prompt count.
   */
  async getQuota(): Promise<number | null> {
    const cfg = vscode.workspace.getConfiguration("promptImprover");
    const proxyUrl =
      cfg.get<string>("proxyUrl") ||
      "https://promptpilot-proxy.5farzinhamzei.workers.dev/improve";

    try {
      const res = await fetch(proxyUrl, {
        method: "GET",
        headers: {
          "X-Machine-ID": vscode.env.machineId,
        },
      });

      if (!res.ok) return null;
      const data = (await res.json()) as { remaining?: number };
      return typeof data.remaining === "number" ? data.remaining : null;
    } catch {
      return null;
    }
  }

  // ── Tier 3 ────────────────────────────────────────────────────────────────

  private async tryProxy(userMsg: string): Promise<ImproveResult> {
    const cfg = vscode.workspace.getConfiguration("promptImprover");
    const proxyUrl =
      cfg.get<string>("proxyUrl") ||
      "https://promptpilot-proxy.5farzinhamzei.workers.dev/improve";

    let res: Response;
    try {
      res = await fetch(proxyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Machine-ID": vscode.env.machineId,
        },
        body: JSON.stringify({ systemPrompt: SYSTEM_PROMPT, userMessage: userMsg }),
      });
    } catch {
      throw new Error(
        "Cannot reach the improvement service. Check your internet connection."
      );
    }

    if (res.status === 429) {
      const data = (await res.json()) as { error: string };
      throw new Error(data.error);
    }

    if (!res.ok) {
      throw new Error(`Proxy error ${res.status}. Please try again.`);
    }

    const data = (await res.json()) as { improved: string; remaining: number };
    return { improved: data.improved, remaining: data.remaining };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private defaultModel(provider: string): string {
    const defaults: Record<string, string> = {
      openai: "gpt-4o-mini",
      groq: "llama-3.1-8b-instant",
      anthropic: "claude-3-5-haiku-latest",
      ollama: "llama3.2",
    };
    return defaults[provider] ?? "gpt-4o-mini";
  }

  private defaultBaseUrl(provider: string): string {
    const urls: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      groq: "https://api.groq.com/openai/v1",
      ollama: "http://localhost:11434/v1",
    };
    return urls[provider] ?? "https://api.openai.com/v1";
  }
}
