// Behavioral tests for LlmService — step 2: cloud-fallback consent + provider-aware tiers.
// Run from the PROJECT ROOT:
//   npx tsx --tsconfig test/tsconfig.json test/llm-service.test.mts

import * as vscode from "vscode";
import { LlmService } from "../src/llm/LlmService";

const state = (vscode as any).__state as {
	config: Map<string, unknown>;
	warningResponses: (string | undefined)[];
	warningCalls: { message: string; options?: { modal?: boolean; detail?: string }; items: string[] }[];
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

function installFetch(behavior: "all-ok" | "key-fails" | "ollama-down") {
	fetchCalls = [];
	(globalThis as any).fetch = async (url: unknown, opts: unknown) => {
		const u = String(url);
		fetchCalls.push({ url: u, opts });
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

function resetState() {
	state.config.clear();
	state.warningResponses = [];
	state.warningCalls = [];
	state.lmModels = [];
	state.lmCalls = 0;
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

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
