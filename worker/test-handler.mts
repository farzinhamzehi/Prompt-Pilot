// Local logic tests for the hardened worker — mocks KV and Workers AI.
// Not part of the shipped worker; excluded from tsconfig via the .mts extension.
// Run:  npx tsx test-handler.mts   (from the worker/ directory)

import * as mod from "./index";

// Unwrap default-export wrapping (CJS/ESM interop differs across runners)
type WorkerModule = { fetch: (req: Request, env: unknown) => Promise<Response> };
function resolveWorker(m: unknown): WorkerModule {
	let cur: any = m;
	while (cur && typeof cur.fetch !== "function" && cur.default) cur = cur.default;
	if (!cur || typeof cur.fetch !== "function") {
		throw new Error("Cannot locate worker.fetch export");
	}
	return cur as WorkerModule;
}
const worker = resolveWorker(mod);

function makeKV() {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string): Promise<string | null> {
			return store.has(key) ? store.get(key)! : null;
		},
		async put(key: string, value: string): Promise<void> {
			store.set(key, value);
		},
	};
}

type Captured = {
	messages?: { role: string; content: string }[];
	model?: string;
	inputs?: Record<string, unknown>;
};

function makeAI(mode: "ok" | "fail" | "empty", capture?: Captured) {
	return {
		async run(model: string, inputs: { messages: { role: string; content: string }[] } & Record<string, unknown>) {
			if (capture) {
				capture.messages = inputs.messages;
				capture.model = model;
				capture.inputs = inputs;
			}
			if (mode === "fail") throw new Error("AI is down");
			if (mode === "empty") return { response: "" };
			return { response: "  IMPROVED-PROMPT  " };
		},
	};
}

function makeEnv(kv: ReturnType<typeof makeKV>, ai: unknown, vars: Record<string, string> = {}) {
	return {
		RATE_LIMIT: kv,
		AI: ai,
		DAILY_LIMIT: vars.DAILY_LIMIT,
		GLOBAL_DAILY_LIMIT: vars.GLOBAL_DAILY_LIMIT,
		SYSTEM_PROMPT: vars.SYSTEM_PROMPT,
		CF_MODEL: vars.CF_MODEL,
	} as any;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
	return new Request("https://proxy.test/improve", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const H = { "X-Machine-ID": "machine-1", "CF-Connecting-IP": "1.2.3.4" };

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: unknown) {
	if (cond) {
		passed++;
		console.log(`PASS  ${name}`);
	} else {
		failed++;
		console.log(`FAIL  ${name}`, extra ?? "");
	}
}

async function main() {
	// 1. Happy path + server-side system prompt (client's systemPrompt ignored)
	{
		const kv = makeKV();
		const capture: Captured = {};
		const env = makeEnv(kv, makeAI("ok", capture));
		const res = await worker.fetch(post({ systemPrompt: "EVIL CLIENT PROMPT", userMessage: "make login faster" }, H), env);
		const data = (await res.json()) as any;
		check("happy path returns 200", res.status === 200, res.status);
		check("happy path returns trimmed improved text", data.improved === "IMPROVED-PROMPT", data);
		check("happy path returns remaining=29, limit=30", data.remaining === 29 && data.limit === 30, data);
		const sys = capture.messages?.[0]?.content ?? "";
		check("server-side system prompt used (client's ignored)", sys.includes("expert prompt engineer") && !sys.includes("EVIL"), sys.slice(0, 60));
		const counted = [...kv.store.values()].filter((v) => v === "1").length;
		check("exactly 3 counters incremented (machine, ip, global)", counted === 3, [...kv.store.entries()]);
		check("default model is the stronger 70B model", capture.model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast", capture.model);
		check("output budget raised to 4096 tokens", capture.inputs?.max_tokens === 4096, capture.inputs?.max_tokens);
		check("temperature lowered to 0.25 for fidelity", capture.inputs?.temperature === 0.25, capture.inputs?.temperature);
	}

	// 2. Invalid JSON -> 400, consumes no quota (B1 fix)
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		const res = await worker.fetch(post("not-json{{{", H), env);
		check("invalid JSON -> 400", res.status === 400, res.status);
		check("invalid JSON consumes no quota", kv.store.size === 0, [...kv.store.entries()]);
	}

	// 3. Missing userMessage -> 400, no quota
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		const res = await worker.fetch(post({ systemPrompt: "x" }, H), env);
		check("missing userMessage -> 400", res.status === 400, res.status);
		check("missing userMessage consumes no quota", kv.store.size === 0);
	}

	// 4. Over-long message -> 400, no quota
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		const res = await worker.fetch(post({ userMessage: "a".repeat(8001) }, H), env);
		check("over 8000 chars -> 400", res.status === 400, res.status);
		check("over-long consumes no quota", kv.store.size === 0);
	}

	// 5. AI failure -> 502, no quota consumed (B1 fix)
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("fail"));
		const res = await worker.fetch(post({ userMessage: "hello world" }, H), env);
		check("AI failure -> 502", res.status === 502, res.status);
		check("AI failure consumes no quota", kv.store.size === 0, [...kv.store.entries()]);
	}

	// 6. Empty AI response -> 502, no quota
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("empty"));
		const res = await worker.fetch(post({ userMessage: "hello world" }, H), env);
		check("empty AI response -> 502", res.status === 502, res.status);
		check("empty AI response consumes no quota", kv.store.size === 0);
	}

	// 7. Daily limit: 30 ok, 31st -> 429 with structured code + legacy text
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		for (let i = 0; i < 30; i++) {
			await worker.fetch(post({ userMessage: "prompt " + i }, H), env);
		}
		const res = await worker.fetch(post({ userMessage: "one more" }, H), env);
		const data = (await res.json()) as any;
		check("31st request -> 429", res.status === 429, res.status);
		check("429 body has code RATE_LIMITED", data.code === "RATE_LIMITED", data);
		check("429 text still contains 'limit reached' (old-client compat)", typeof data.error === "string" && data.error.includes("limit reached"), data.error);
	}

	// 8. IP backstop: 30 forged machine IDs from one IP -> blocked
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		for (let i = 0; i < 30; i++) {
			await worker.fetch(post({ userMessage: "x " + i }, { "X-Machine-ID": "forged-" + i, "CF-Connecting-IP": "9.9.9.9" }), env);
		}
		const res = await worker.fetch(post({ userMessage: "again" }, { "X-Machine-ID": "forged-31", "CF-Connecting-IP": "9.9.9.9" }), env);
		check("forged machine IDs from one IP are stopped -> 429", res.status === 429, res.status);
	}

	// 9. GET quota: returns remaining+limit, never increments
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		await worker.fetch(post({ userMessage: "one" }, H), env); // uses 1
		const get = () => new Request("https://proxy.test/improve", { method: "GET", headers: H });
		const res = await worker.fetch(get(), env);
		const data = (await res.json()) as any;
		check("GET returns remaining=29 limit=30", data.remaining === 29 && data.limit === 30, data);
		const res2 = await worker.fetch(get(), env);
		const data2 = (await res2.json()) as any;
		check("GET does not consume quota", data2.remaining === 29, data2);
	}

	// 10. NaN DAILY_LIMIT falls back to default (P7 fix)
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"), { DAILY_LIMIT: "banana" });
		const res = await worker.fetch(new Request("https://proxy.test/improve", { method: "GET", headers: H }), env);
		const data = (await res.json()) as any;
		check("NaN DAILY_LIMIT falls back to 30", data.limit === 30 && data.remaining === 30, data);
	}

	// 11. Global circuit breaker: GLOBAL_DAILY_LIMIT=2 -> third request 503
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"), { GLOBAL_DAILY_LIMIT: "2" });
		await worker.fetch(post({ userMessage: "a" }, { "X-Machine-ID": "m1", "CF-Connecting-IP": "5.5.5.5" }), env);
		await worker.fetch(post({ userMessage: "b" }, { "X-Machine-ID": "m2", "CF-Connecting-IP": "6.6.6.6" }), env);
		const res = await worker.fetch(post({ userMessage: "c" }, { "X-Machine-ID": "m3", "CF-Connecting-IP": "7.7.7.7" }), env);
		check("global cap reached -> 503", res.status === 503, res.status);
	}

	// 12. No CORS headers anywhere (S3 fix)
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		const res = await worker.fetch(post({ userMessage: "hi" }, H), env);
		check("no Access-Control-Allow-Origin on POST response", res.headers.get("Access-Control-Allow-Origin") === null);
		const opt = await worker.fetch(new Request("https://proxy.test/improve", { method: "OPTIONS" }), env);
		check("OPTIONS answered 204 without CORS headers", opt.status === 204 && opt.headers.get("Access-Control-Allow-Origin") === null, opt.status);
	}

	// 13. JSON body "null" -> 400 (no crash)
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		const res = await worker.fetch(post("null", H), env);
		check("body 'null' -> 400, no crash", res.status === 400, res.status);
	}

	// 14. Model override via CF_MODEL env var (quality knob without code change)
	{
		const kv = makeKV();
		const capture: Captured = {};
		const env = makeEnv(kv, makeAI("ok", capture), { CF_MODEL: "@cf/meta/llama-3.2-3b-instruct" });
		await worker.fetch(post({ userMessage: "hi" }, H), env);
		check("CF_MODEL env var overrides the default model", capture.model === "@cf/meta/llama-3.2-3b-instruct", capture.model);
	}

	// 15. Oversized body rejected BEFORE parsing (413), no quota consumed
	{
		const kv = makeKV();
		const env = makeEnv(kv, makeAI("ok"));
		// Note: undici does not auto-expose content-length on Request.headers for
		// string bodies, so set it explicitly to simulate a real HTTP client.
		const res = await worker.fetch(
			new Request("https://proxy.test/improve", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": "200000", ...H },
				body: "{}",
			}),
			env
		);
		check("oversized body -> 413 before parsing", res.status === 413, res.status);
		check("oversized body consumes no quota", kv.store.size === 0);
	}

	// 33. System prompt guards location markers (A/B finding: never drop L4-21)
	{
		const sp = (mod as any).SYSTEM_PROMPT as string;
		check("system prompt is exported for guarding", typeof sp === "string" && sp.length > 100);
		check("system prompt preserves location markers verbatim (e.g. L4-21)", /L4-21/.test(sp) && /verbatim/.test(sp), sp?.slice(0, 80));
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
