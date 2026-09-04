export interface Env {
	RATE_LIMIT: KVNamespace;
	AI: Ai;
	DAILY_LIMIT?: string;
	GLOBAL_DAILY_LIMIT?: string;
	SYSTEM_PROMPT?: string;
	// Optional model override, e.g. CF_MODEL = "@cf/meta/llama-3.2-3b-instruct"
	// in wrangler.toml [vars] to fall back to the cheaper/faster small model.
	CF_MODEL?: string;
}

// ---------------------------------------------------------------------------
// Model & limits
// ---------------------------------------------------------------------------

// Default: Llama 3.3 70B (fp8) — dramatically better instruction-following
// than the old 3B model for structured prompt rewrites. Override via the
// CF_MODEL var in wrangler.toml if you prefer the cheaper 3B model.
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_USER_MESSAGE_LENGTH = 8000;
// Raised from 2048: long structured prompts were being truncated mid-output,
// which made whole sections silently disappear from the result.
const MAX_OUTPUT_TOKENS = 4096;
// Lowered from 0.4: more faithful preservation of the draft's details.
const TEMPERATURE = 0.25;
const DEFAULT_DAILY_LIMIT = 30;
const DEFAULT_GLOBAL_DAILY_LIMIT = 20000;
const COUNTER_TTL_SECONDS = 90000; // ~25h: covers one UTC day + margin

// ---------------------------------------------------------------------------
// System prompt — lives ONLY on the server now. The client's `systemPrompt`
// field is deliberately ignored, so this proxy can never be repurposed as a
// general-purpose chatbot. Keep in sync with src/core/improvementEngine.ts.
// Optional override without a code change: [vars] SYSTEM_PROMPT in wrangler.toml
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are an expert prompt engineer specializing in software-development prompts and AI coding agents.

Your ONLY job is to transform the user's raw prompt into a clear, precise, actionable, and implementation-ready prompt.

==================================================
CORE RULES
==================================================

NEVER answer or execute the underlying task.
NEVER invent file paths, APIs, components, database tables, business rules, or architecture that were not provided.
NEVER remove constraints the user explicitly stated.
NEVER introduce requirements that contradict the user's intent.
ALWAYS reply in the same language as the draft prompt.
ALWAYS keep code snippets, file paths, and identifiers exactly as written.
ALWAYS preserve location markers verbatim — a reference like \`L4-21\` or \`#L12\` must appear in the improved prompt exactly as written, never paraphrased (e.g., not "lines 4-21").
If you make an assumption, mark it explicitly as: Assumption: ...
NEVER omit information: the improved prompt MUST explicitly cover every requirement, detail, file path, and identifier present in the draft.

==================================================
WHAT YOU MUST DO
==================================================

1. UNDERSTAND THE INTENT
   Determine the user's actual goal, the expected result, and what constraints are explicit or implied.

2. ANALYZE THE ORIGINAL PROMPT
   Identify: ambiguous requirements, missing context, vague language, conflicting instructions, missing validation, and unclear expected output.

3. PRESERVE CONSTRAINTS
   Make all constraints explicit. Never silently drop a constraint.

4. REPLACE VAGUE LANGUAGE
   Replace phrases such as "make it better", "make it clean", "don't break anything", "use existing logic", "optimize everything" with concrete, testable requirements.

5. STRUCTURE FOR EXECUTION
   When appropriate, structure the improved prompt with:
   - Analysis phase (what the agent must inspect before writing code)
   - Reuse rules (what existing logic must be reused, what must not be duplicated)
   - Implementation requirements (concrete, testable)
   - Validation (how to verify the result)
   - Expected output (what the agent must report)

6. SCALE APPROPRIATELY
   Simple task → concise improved prompt (a few clear sentences)
   Medium task → add context, requirements, constraints, and validation
   Complex task → structured phases with analysis, implementation rules, validation, and reporting

==================================================
OUTPUT FORMAT
==================================================

Return ONLY the improved prompt.
No preamble. No explanation. No markdown code fences wrapping the entire output.
The improved prompt must be ready to paste directly into an AI agent.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
	// No CORS headers on purpose: the only legitimate client is the VS Code
	// extension host (Node.js fetch), which does not enforce CORS. CORS "*"
	// previously let any website call this worker from a visitor's browser.
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const n = parseInt(value ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function todayKey(): string {
	return new Date().toISOString().slice(0, 10); // UTC day
}

async function readCount(kv: KVNamespace, key: string): Promise<number> {
	const raw = await kv.get(key);
	if (raw === null) return 0;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : 0; // corrupted value -> 0, never NaN
}

/**
 * Read-only quota check. Never writes to KV — so failed requests (bad JSON,
 * too-long prompts, AI errors) never consume the user's daily quota.
 */
async function checkLimit(
	kv: KVNamespace,
	key: string,
	limit: number
): Promise<{ allowed: boolean; remaining: number }> {
	const count = await readCount(kv, key);
	if (count >= limit) return { allowed: false, remaining: 0 };
	return { allowed: true, remaining: limit - count };
}

/** Increments a counter. Called ONLY after a successful AI response. */
async function incrementCounter(kv: KVNamespace, key: string): Promise<void> {
	const count = await readCount(kv, key);
	await kv.put(key, String(count + 1), { expirationTtl: COUNTER_TTL_SECONDS });
}

function getIdentifiers(request: Request): { machineId: string | null; ip: string } {
	const rawMachine = request.headers.get("X-Machine-ID");
	const machineId = rawMachine && rawMachine.trim().length > 0 ? rawMachine.trim() : null;
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	return { machineId, ip };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			if (request.method === "OPTIONS") {
				return new Response(null, { status: 204 }); // no CORS headers
			}

			const dailyLimit = parsePositiveInt(env.DAILY_LIMIT, DEFAULT_DAILY_LIMIT);
			const globalDailyLimit = parsePositiveInt(env.GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT);
			const { machineId, ip } = getIdentifiers(request);
			const day = todayKey();

			// Three independent counters:
			//  - machine: what the extension displays to the user
			//  - ip:      backstop — forging machine IDs no longer grants fresh quota
			//  - global:  circuit breaker that bounds the owner's daily cost
			const machineKey = `rl:m:${machineId ?? "anon"}:${day}`;
			const ipKey = `rl:ip:${ip}:${day}`;
			const globalKey = `rl:global:${day}`;

			// --- GET: remaining quota (read-only, never increments) ---
			if (request.method === "GET") {
				const machine = await checkLimit(env.RATE_LIMIT, machineKey, dailyLimit);
				const ipCheck = await checkLimit(env.RATE_LIMIT, ipKey, dailyLimit);
				return json({
					remaining: Math.min(machine.remaining, ipCheck.remaining),
					limit: dailyLimit,
				});
			}

			if (request.method !== "POST") {
				return json({ error: "Method not allowed" }, 405);
			}

			// --- 1. Validate BEFORE touching any counter (failed requests are free) ---

			// Cheap pre-filter: reject absurdly large bodies without parsing them.
			// (Legit payloads are ~11 KB max; the post-parse length check below
			// remains the authoritative limit for the prompt text itself.)
			const contentLength = Number(request.headers.get("content-length") ?? 0);
			if (Number.isFinite(contentLength) && contentLength > 64_000) {
				return json({ error: "Request body too large" }, 413);
			}

			let rawBody: unknown;
			try {
				rawBody = await request.json();
			} catch {
				return json({ error: "Invalid JSON body" }, 400);
			}

			const body = (rawBody ?? {}) as Record<string, unknown>;
			// body.systemPrompt is intentionally NOT read here (server-side only).
			const userMessage = typeof body.userMessage === "string" ? body.userMessage : "";

			if (!userMessage.trim()) {
				return json({ error: "Missing userMessage" }, 400);
			}
			if (userMessage.length > MAX_USER_MESSAGE_LENGTH) {
				return json(
					{ error: `Prompt too long (max ${MAX_USER_MESSAGE_LENGTH} characters)` },
					400
				);
			}

			// --- 2. Read-only quota checks: machine + IP + global ---
			const [machine, ipCheck, globalCheck] = await Promise.all([
				checkLimit(env.RATE_LIMIT, machineKey, dailyLimit),
				checkLimit(env.RATE_LIMIT, ipKey, dailyLimit),
				checkLimit(env.RATE_LIMIT, globalKey, globalDailyLimit),
			]);

			if (!globalCheck.allowed) {
				return json(
					{ error: "Service is at capacity today. Please try again tomorrow." },
					503
				);
			}

			if (!machine.allowed || !ipCheck.allowed) {
				return json(
					{
						error: `Free tier limit reached (${dailyLimit} requests/day). Add your own API key in Prompt Improver settings for unlimited use.`,
						code: "RATE_LIMITED",
						remaining: 0,
						limit: dailyLimit,
					},
					429
				);
			}

			// --- 3. Call the model with the SERVER-SIDE system prompt ---
			let improved: string | undefined;
			try {
				const response = await env.AI.run(env.CF_MODEL ?? DEFAULT_MODEL, {
					messages: [
						{ role: "system", content: env.SYSTEM_PROMPT ?? SYSTEM_PROMPT },
						{ role: "user", content: userMessage },
					],
					max_tokens: MAX_OUTPUT_TOKENS,
					temperature: TEMPERATURE,
				});

				improved = (response as { response?: string }).response?.trim();
			} catch (err) {
				console.error("Cloudflare AI error:", err);
				return json({ error: "AI service error. Please try again." }, 502);
			}

			if (!improved) {
				return json({ error: "Empty response from AI" }, 502);
			}

			// --- 4. Success — only now does the request count ---
			await Promise.all([
				incrementCounter(env.RATE_LIMIT, machineKey),
				incrementCounter(env.RATE_LIMIT, ipKey),
				incrementCounter(env.RATE_LIMIT, globalKey),
			]);

			return json({
				improved,
				remaining: Math.max(0, Math.min(machine.remaining, ipCheck.remaining) - 1),
				limit: dailyLimit,
			});
		} catch (err) {
			console.error("Unhandled worker error:", err);
			return json({ error: "Internal error. Please try again." }, 500);
		}
	},
};
