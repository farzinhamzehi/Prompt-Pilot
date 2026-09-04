// Step-6 tests: a result that completes while the panel is hidden must not
// vanish — it is stashed in workspaceState and delivered on the next resolve.
// Also covers the dynamic quota limit forwarded to the webview (B3).
// Run from the PROJECT ROOT:
//   npx tsx --tsconfig test/tsconfig.json test/pending-result.test.mts

import * as vscode from "vscode";
import { PromptPanelProvider } from "../src/PromptPanelProvider";

const state = (vscode as any).__state as { lmModels: unknown[] };

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

function makeContext() {
	const store = new Map<string, unknown>();
	const memento = {
		get: (key: string) => store.get(key),
		update: async (key: string, value: unknown) => {
			if (value === undefined) store.delete(key);
			else store.set(key, value);
		},
	};
	return {
		store,
		ctx: {
			subscriptions: [],
			secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
			workspaceState: memento,
			globalState: memento,
		},
	};
}

function makeView(postMessageImpl: (m: unknown) => Promise<boolean>) {
	let handler: ((msg: any) => unknown) | null = null;
	const messages: unknown[] = [];
	const view = {
		webview: {
			options: {} as Record<string, unknown>,
			html: "",
			postMessage: async (m: unknown) => {
				messages.push(m);
				return postMessageImpl(m);
			},
			onDidReceiveMessage: (fn: (msg: any) => unknown) => {
				handler = fn;
				return { dispose() {} };
			},
		},
	};
	return { view, messages, fire: (msg: any) => handler?.(msg) };
}

async function main() {
	// Network: the proxy answers both GET (quota) and POST (improve).
	(globalThis as any).fetch = async (url: unknown) => {
		const u = String(url);
		if (u.includes("workers.dev")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ improved: "PROXY-RESULT", remaining: 29, limit: 30 }),
				text: async () => "",
			};
		}
		throw new Error("unexpected url " + u);
	};
	state.lmModels = []; // no Copilot models -> falls through to the proxy

	// 1. Panel hidden mid-request: postMessage reports failure -> result is stashed
	const { ctx, store } = makeContext();
	const provider = new PromptPanelProvider(ctx as any);
	const v1 = makeView(async () => false); // destroyed webview drops messages
	provider.resolveWebviewView(v1.view as any);
	await v1.fire({
		type: "improve",
		prompt: "make the login form better",
		preset: "specific",
		options: { implementationPlan: false, commitChanges: false, pushCommits: false },
	});
	const stashed = store.get("promptImprover.pendingResult") as any;
	check("dropped result is stashed in workspaceState", !!stashed, [...store.keys()]);
	check(
		"stashed payload keeps the improved text",
		typeof stashed?.improved === "string" && stashed.improved.includes("PROXY-RESULT"),
		stashed
	);
	check("stashed payload keeps remaining+limit", stashed?.remaining === 29 && stashed?.limit === 30, stashed);

	// 2. Next resolve delivers the stash and then clears it
	const v2 = makeView(async () => true);
	provider.resolveWebviewView(v2.view as any);
	await new Promise((r) => setTimeout(r, 10)); // let the .then chains flush
	const delivered = v2.messages.find((m: any) => m?.type === "result") as any;
	check(
		"next resolve delivers the stashed result",
		!!delivered && typeof delivered.improved === "string" && delivered.improved.includes("PROXY-RESULT"),
		v2.messages
	);
	check(
		"stash is cleared after successful delivery",
		store.get("promptImprover.pendingResult") === undefined,
		store.get("promptImprover.pendingResult")
	);

	// 3. Quota sync forwards the dynamic limit to the webview (B3)
	const quotaMsg = v2.messages.find((m: any) => m?.type === "quota") as any;
	check("quota sync forwards the limit", quotaMsg?.limit === 30, v2.messages);

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
