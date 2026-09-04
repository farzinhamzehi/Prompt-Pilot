// Behavioral tests for LlmService — step 2: cloud-fallback consent + provider-aware tiers.
// Run from the PROJECT ROOT:
//   npx tsx --tsconfig test/tsconfig.json test/llm-service.test.mts

import * as vscode from "vscode";
import { LlmService, RateLimitError, TIMEOUTS } from "../src/llm/LlmService";

const state = (vscode as any).__state as {
	config: Map<string, unknown>;
	warningResponses: (string | undefined)[];
	warningCalls: { message: string; options?: { modal?: boolean; detail?: string }; items: string[] }[];
	tokenSourcesCreated: number;
	tokenSourcesDisposed: number;
	lmModels: unknown[];
	lmCalls: number;
};

let currentKey: string | undefined;
const ctx = {
	secrets: {
		get: async () => currentKey,
		store: async () => {},
		delete: async () => {},
	},
};

function streamingModel(text: string) {
	return {
		async sendRequest() {
			return {
				text: (async function* () {
					yield text;
				})(),
			};
		},
	};
}

type FetchCall = { url: string; opts: any };
let fetchCalls: FetchCall[] = [];

function jsonResponse(data: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => data,
		text: async () => JSON.stringify(data),
	};
}

function installFetch(behavior: "all-ok" | "key-fails" | "ollama-down" | "proxy-limited") {
	fetchCalls = [];
	(globalThis as any).fetch = async (url: unknown, opts: unknown) => {
		const u = String(url);
		fetchCalls.push({ url: u, opts });
		if (behavior === "proxy-limited" && u.includes("workers.dev")) {
			return jsonResponse(
				{
					error:
						"Free tier limit reached (30 requests/day). Add your own API key in Prompt Improver settings for unlimited use.",
					code: "RATE_LIMITED",
					remaining: 0,
					limit: 30,
				},
				429
			);
		}
		if (u.includes("workers.dev")) {
			return jsonResponse({ improved: "PROXY-RESULT", remaining: 29, limit: 30 });
		}
		if (behavior === "key-fails") {
			return jsonResponse({ error: { message: "invalid api key" } }, 401);
		}
		if (behavior === "ollama-down") {
			throw new TypeError("fetch failed"); // connection refused
		}
		return jsonResponse({ choices: [{ message: { content: "TIER2-RESULT" } }] });
	};
}

// A fetch that never answers on its own — only the caller's AbortSignal can
// end it. Simulates a hung network/provider.
function installHangingFetch() {
	fetchCalls = [];
	(globalThis as any).fetch = (url: unknown, opts: any) =>
		new Promise((_resolve, reject) => {
			const u = String(url);
			fetchCalls.push({ url: u, opts });
			// AbortSignal.timeout() uses an unref'd timer in Node, which by itself
			// will not keep a short-lived test process alive — the process would
			// exit mid-await before the abort fires. A referenced interval keeps
			// the loop alive until the abort lands, then is cleared.
			const keepAlive = setInterval(() => {}, 10);
			opts?.signal?.addEventListener?.("abort", () => {
				clearInterval(keepAlive);
				const err = new Error("The operation timed out.");
				err.name = "TimeoutError";
				reject(err);
			});
		});
}

function resetState() {
	state.config.clear();
	state.warningResponses = [];
	state.warningCalls = [];
	state.lmModels = [];
	state.lmCalls = 0;
	state.tokenSourcesCreated = 0;
	state.tokenSourcesDisposed = 0;
	currentKey = undefined;
	installFetch("all-ok");
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (cond) {
		passed++;
		console.log("PASS  " + name);
	} else {
		failed++;
		console.log("FAIL  " + name, extra ?? "");
	}
}

const svc = () => new LlmService(ctx as any);
const proxyCalled = () => fetchCalls.some((c) => c.url.includes("workers.dev"));
const providerCalled = (host: string) => fetchCalls.some((c) => c.url.includes(host));

async function main() {
	// 1. Free user, no Copilot, no key -> straight to proxy (unchanged)
	resetState();
	{
		const r = await svc().improve("make a login form", "specific");
		check("free user falls through to proxy", r.improved === "PROXY-RESULT", r);
		check("free user: no consent dialog shown", state.warningCalls.length === 0);
		check("free user: proxy result carries the limit field", r.limit === 30, r);
	}

	// 2. Free user WITH Copilot -> Tier 1 wins, network never touched
	resetState();
	state.lmModels = [streamingModel("TIER1-RESULT")];
	{
		const r = await svc().improve("make a login form", "specific");
		check("copilot user gets Tier-1 result", r.improved === "TIER1-RESULT", r);
		check("copilot user: zero network calls", fetchCalls.length === 0, fetchCalls);
	}

	// 3. Key user (openai) + Copilot available -> Tier 1 still wins (unchanged)
	resetState();
	currentKey = "sk-test";
	state.config.set("promptImprover.userProvider", "openai");
	state.lmModels = [streamingModel("TIER1-RESULT")];
	{
		const r = await svc().improve("draft", "shorter");
		check("cloud-key user keeps Copilot-first behavior", r.improved === "TIER1-RESULT", r);
		check("cloud-key user: own key untouched when Tier 1 works", !providerCalled("api.openai.com"), fetchCalls);
	}

	// 4. Key user, no Copilot, key works -> Tier 2 with Bearer header
	resetState();
	currentKey = "sk-test";
	state.config.set("promptImprover.userProvider", "openai");
	{
		const r = await svc().improve("draft", "shorter");
		const call = fetchCalls.find((c) => c.url.includes("api.openai.com"));
		check("Tier-2 result returned", r.improved === "TIER2-RESULT", r);
		check("Tier-2 sends Bearer key", (call?.opts?.headers?.Authorization ?? "") === "Bearer sk-test", call?.opts?.headers);
		check("Tier-2 success: no consent dialog", state.warningCalls.length === 0);
	}

	// 5. Key FAILS, user DISMISSES dialog -> throws, prompt NEVER reaches proxy (core fix)
	resetState();
	currentKey = "sk-bad";
	state.config.set("promptImprover.userProvider", "openai");
	installFetch("key-fails");
	state.warningResponses = [undefined]; // user presses Escape
	{
		let err: unknown = null;
		try {
			await svc().improve("secret draft", "structured");
		} catch (e) {
			err = e;
		}
		check("declined consent -> improve() throws", err instanceof Error, err);
		check("error says prompt was NOT sent elsewhere", /NOT sent anywhere else/.test(String(err)), String(err));
		check("declined consent -> proxy NEVER called", !proxyCalled(), fetchCalls);
		check("consent dialog is modal", state.warningCalls[0]?.options?.modal === true, state.warningCalls[0]?.options);
	}

	// 6. Key fails, user picks "Use Cloud Proxy This Time" -> proxy used, nothing persisted
	resetState();
	currentKey = "sk-bad";
	state.config.set("promptImprover.userProvider", "openai");
	installFetch("key-fails");
	state.warningResponses = ["Use Cloud Proxy This Time"];
	{
		const r = await svc().improve("draft", "specific");
		check("one-time consent -> proxy used", r.improved === "PROXY-RESULT", r);
		check("one-time consent does NOT persist", state.config.get("promptImprover.allowCloudFallback") === undefined);
	}

	// 7. "Always Allow" persists; later failures skip the dialog entirely
	resetState();
	currentKey = "sk-bad";
	state.config.set("promptImprover.userProvider", "openai");
	installFetch("key-fails");
	state.warningResponses = ["Always Allow Cloud Fallback"];
	{
		const r = await svc().improve("draft", "specific");
		check("always-consent -> proxy used", r.improved === "PROXY-RESULT");
		check("always-consent persists setting", state.config.get("promptImprover.allowCloudFallback") === true);
		state.warningCalls = [];
		state.warningResponses = [];
		const r2 = await svc().improve("draft2", "specific");
		check("subsequent failure skips the dialog", state.warningCalls.length === 0 && r2.improved === "PROXY-RESULT", state.warningCalls.length);
	}

	// 8. Ollama user WITH Copilot installed -> Tier 1 SKIPPED, local Ollama used
	resetState();
	currentKey = "ollama-no-key";
	state.config.set("promptImprover.userProvider", "ollama");
	state.config.set("promptImprover.userBaseUrl", "http://localhost:11434/v1");
	state.lmModels = [streamingModel("TIER1-RESULT")]; // Copilot is available!
	{
		const r = await svc().improve("draft", "specific");
		check("ollama user: vscode.lm never consulted", state.lmCalls === 0, state.lmCalls);
		check("ollama user: localhost provider called", providerCalled("localhost:11434"), fetchCalls);
		check("ollama user: gets local Tier-2 result", r.improved === "TIER2-RESULT", r);
	}

	// 9. Ollama down + dismiss -> throws, proxy never called, dialog mentions privacy
	resetState();
	currentKey = "ollama-no-key";
	state.config.set("promptImprover.userProvider", "ollama");
	installFetch("ollama-down");
	state.warningResponses = [undefined];
	{
		let err: unknown = null;
		try {
			await svc().improve("private draft", "structured");
		} catch (e) {
			err = e;
		}
		check("ollama down + dismiss -> throws", err instanceof Error);
		check("ollama down + dismiss -> proxy NEVER called", !proxyCalled(), fetchCalls);
		check(
			"ollama dialog explains local/private impact",
			/local, private use/.test(state.warningCalls[0]?.options?.detail ?? ""),
			state.warningCalls[0]?.options?.detail
		);
	}

	// 10. Ollama down + one-time consent -> proxy used
	resetState();
	currentKey = "ollama-no-key";
	state.config.set("promptImprover.userProvider", "ollama");
	installFetch("ollama-down");
	state.warningResponses = ["Use Cloud Proxy This Time"];
	{
		const r = await svc().improve("draft", "shorter");
		check("ollama down + consent -> proxy used", r.improved === "PROXY-RESULT", r);
	}

	// 11. Proxy 429 -> typed RateLimitError carrying the server message
	resetState();
	installFetch("proxy-limited");
	{
		let err: unknown = null;
		try {
			await svc().improve("draft", "structured");
		} catch (e) {
			err = e;
		}
		check("proxy 429 -> RateLimitError instance", err instanceof RateLimitError, String(err));
		check("RateLimitError preserves the server message", /limit reached/.test(String(err)), String(err));
		check("RateLimitError carries its own name", (err as Error | null)?.name === "RateLimitError", (err as Error | null)?.name);
	}

	// 12. Provider call hangs -> bounded wait, consent dialog mentions timeout,
	//     and on decline the proxy is never touched
	resetState();
	currentKey = "sk-slow";
	state.config.set("promptImprover.userProvider", "openai");
	installHangingFetch();
	const savedLlmMs = TIMEOUTS.llmMs;
	TIMEOUTS.llmMs = 60;
	state.warningResponses = [undefined];
	try {
		const started = Date.now();
		let err: unknown = null;
		try {
			await svc().improve("draft", "specific");
		} catch (e) {
			err = e;
		}
		const elapsed = Date.now() - started;
		check("hanging provider -> rejects within the budget (no forever spinner)", elapsed < 2000, elapsed);
		check("hanging provider -> consent dialog shown", state.warningCalls.length === 1, state.warningCalls.length);
		check("dialog detail mentions the timeout", /took too long/i.test(state.warningCalls[0]?.options?.detail ?? ""), state.warningCalls[0]?.options?.detail);
		check("declined after timeout -> proxy NEVER called", !proxyCalled(), fetchCalls);
		check("declined after timeout -> throws", err instanceof Error);
	} finally {
		TIMEOUTS.llmMs = savedLlmMs;
	}

	// 13. getQuota with a hanging network -> returns null within the quota budget
	resetState();
	installHangingFetch();
	const savedQuotaMs = TIMEOUTS.quotaMs;
	TIMEOUTS.quotaMs = 60;
	try {
		const started = Date.now();
		const remaining = await svc().getQuota();
		const elapsed = Date.now() - started;
		check("getQuota timeout -> returns null", remaining === null, remaining);
		check("getQuota timeout -> bounded wait", elapsed < 2000, elapsed);
	} finally {
		TIMEOUTS.quotaMs = savedQuotaMs;
	}

	// 14. Tier-1 (vscode.lm) hangs -> watchdog cancels the request and we fall
	//     through to the proxy instead of spinning forever
	resetState();
	installFetch("all-ok");
	state.lmModels = [
		{
			sendRequest: (_m: unknown, _o: unknown, token: { isCancellationRequested: boolean }) =>
				new Promise((_res, rej) => {
					const t = setInterval(() => {
						if (token.isCancellationRequested) {
							clearInterval(t);
							rej(new Error("cancelled by watchdog"));
						}
					}, 5);
				}),
		},
	];
	const savedLlmMs2 = TIMEOUTS.llmMs;
	TIMEOUTS.llmMs = 60;
	try {
		const started = Date.now();
		const r = await svc().improve("draft", "shorter");
		const elapsed = Date.now() - started;
		check("hanging Tier-1 -> falls through to proxy", r.improved === "PROXY-RESULT", r);
		check("hanging Tier-1 -> bounded wait", elapsed < 2000, elapsed);
	} finally {
		TIMEOUTS.llmMs = savedLlmMs2;
	}

	// 15. Tier-1 success disposes its CancellationTokenSource (leak fix)
	resetState();
	state.lmModels = [streamingModel("TIER1-RESULT")];
	{
		await svc().improve("draft", "specific");
		check("Tier-1 token source created", state.tokenSourcesCreated === 1, state.tokenSourcesCreated);
		check("Tier-1 token source disposed (no leak)", state.tokenSourcesDisposed === state.tokenSourcesCreated, state.tokenSourcesDisposed);
	}

	// 16. Tier-1 stream that ends early after cancellation -> partial text is
	//     discarded and we fall through instead of returning a truncated prompt
	resetState();
	installFetch("all-ok");
	state.lmModels = [
		{
			sendRequest: (_m: unknown, _o: unknown, token: { isCancellationRequested: boolean }) => ({
				text: (async function* () {
					yield "PARTIAL-";
					while (!token.isCancellationRequested) {
						await new Promise((r) => setTimeout(r, 5));
					}
					// cancellation ends the stream WITHOUT throwing
					return;
				})(),
			}),
		},
	];
	const savedLlmMs3 = TIMEOUTS.llmMs;
	TIMEOUTS.llmMs = 60;
	try {
		const r = await svc().improve("draft", "shorter");
		check("cancelled partial stream -> falls through to proxy", r.improved === "PROXY-RESULT", r);
		check("cancelled partial stream -> partial text never returned", r.improved !== "PARTIAL-", r);
	} finally {
		TIMEOUTS.llmMs = savedLlmMs3;
	}

	// 17. getQuota returns the { remaining, limit } shape from the proxy
	resetState();
	{
		const q = await svc().getQuota();
		check("getQuota returns remaining from the server", q?.remaining === 29, q);
		check("getQuota returns the dynamic limit", q?.limit === 30, q);
	}

	// 18. Anthropic honors userBaseUrl (custom gateway) and x-api-key auth
	resetState();
	currentKey = "sk-ant";
	state.config.set("promptImprover.userProvider", "anthropic");
	state.config.set("promptImprover.userBaseUrl", "https://gateway.example.com/anthropic");
	{
		let seenUrl = "";
		let seenHeaders: Record<string, string> = {};
		(globalThis as any).fetch = async (url: unknown, opts: any) => {
			seenUrl = String(url);
			seenHeaders = opts?.headers ?? {};
			return jsonResponse({ content: [{ type: "text", text: "ANTHROPIC-RESULT" }] });
		};
		const r = await svc().improve("draft", "structured");
		check("anthropic result returned", r.improved === "ANTHROPIC-RESULT", r);
		check("anthropic uses the custom baseUrl", seenUrl === "https://gateway.example.com/anthropic/v1/messages", seenUrl);
		check("anthropic sends x-api-key (not Bearer)", seenHeaders["x-api-key"] === "sk-ant" && !seenHeaders.Authorization, seenHeaders);
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
