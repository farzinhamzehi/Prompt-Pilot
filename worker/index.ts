export interface Env {
  RATE_LIMIT: KVNamespace;
  AI: Ai;
  DAILY_LIMIT: string;
}

const CF_MODEL = "@cf/meta/llama-3.2-3b-instruct";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Machine-ID",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function getIdentifier(request: Request): string {
  const machineId = request.headers.get("X-Machine-ID");
  if (machineId && machineId.trim().length > 0) {
    return machineId.trim();
  }

  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

async function getRemainingQuota(
  kv: KVNamespace,
  identifier: string,
  dailyLimit: number
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:${identifier}:${today}`;

  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  return Math.max(0, dailyLimit - count);
}

async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  dailyLimit: number
): Promise<{ allowed: boolean; remaining: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:${identifier}:${today}`;

  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  await kv.put(key, String(count + 1), { expirationTtl: 90000 });
  return { allowed: true, remaining: dailyLimit - count - 1 };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const dailyLimit = parseInt(env.DAILY_LIMIT ?? "30", 10);
    const identifier = getIdentifier(request);

    // --- GET remaining quota endpoint ---
    if (request.method === "GET") {
      const remaining = await getRemainingQuota(env.RATE_LIMIT, identifier, dailyLimit);
      return json({ remaining });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    // --- Rate limiting ---
    const { allowed, remaining } = await checkRateLimit(env.RATE_LIMIT, identifier, dailyLimit);

    if (!allowed) {
      return json(
        {
          error: `Free tier limit reached (${dailyLimit} requests/day). Add your own API key in Prompt Improver settings for unlimited use.`,
          code: "RATE_LIMITED",
        },
        429
      );
    }

    // --- Parse body ---
    let body: { systemPrompt: string; userMessage: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.systemPrompt || !body.userMessage) {
      return json({ error: "Missing systemPrompt or userMessage" }, 400);
    }

    if (body.userMessage.length > 8000) {
      return json({ error: "Prompt too long (max 8000 characters)" }, 400);
    }

    // --- Call Cloudflare AI ---
    try {
      const response = await env.AI.run(CF_MODEL, {
        messages: [
          { role: "system", content: body.systemPrompt },
          { role: "user", content: body.userMessage },
        ],
        max_tokens: 2048,
        temperature: 0.4,
      });

      const improved = (response as { response?: string }).response?.trim();
      if (!improved) {
        return json({ error: "Empty response from AI" }, 502);
      }

      return json({ improved, remaining });
    } catch (err) {
      console.error("Cloudflare AI error:", err);
      return json({ error: "AI service error. Please try again." }, 502);
    }
  },
};
