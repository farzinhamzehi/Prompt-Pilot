// Step-7 tests for extension.ts command wiring:
//  - the dead promptImprover.focus command is no longer registered
//  - removeApiKey clears the key AND provider settings AND stored consent
// Run from the PROJECT ROOT:
//   npx tsx --tsconfig test/tsconfig.json test/extension-commands.test.mts
// (or together with everything else: npm test)

import * as vscode from "vscode";
import { activate } from "../src/extension";

const state = (vscode as any).__state as {
	config: Map<string, unknown>;
	registeredCommands: Map<string, (...args: unknown[]) => unknown>;
	infoMessages: string[];
};

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

async function main() {
	state.config.clear();
	state.registeredCommands.clear();
	state.infoMessages.length = 0;

	// Seed stale provider settings + stored cloud-fallback consent
	state.config.set("promptImprover.userProvider", "ollama");
	state.config.set("promptImprover.userModel", "llama3.2");
	state.config.set("promptImprover.userBaseUrl", "http://localhost:11434/v1");
	state.config.set("promptImprover.allowCloudFallback", true);

	const deletedKeys: string[] = [];
	const ctx = {
		subscriptions: [],
		secrets: {
			get: async () => undefined,
			store: async () => {},
			delete: async (k: string) => {
				deletedKeys.push(k);
			},
		},
		workspaceState: { get: () => undefined, update: async () => {} },
		globalState: { get: () => undefined, update: async () => {} },
	};

	activate(ctx as any);

	// 1. The dead focus command (never contributed in package.json) is gone
	check(
		"dead promptImprover.focus command is gone",
		!state.registeredCommands.has("promptImprover.focus"),
		[...state.registeredCommands.keys()]
	);

	// 2. removeApiKey clears the key AND all provider-related settings
	const remove = state.registeredCommands.get("promptImprover.removeApiKey");
	check(
		"removeApiKey command is registered",
		typeof remove === "function",
		[...state.registeredCommands.keys()]
	);
	await (remove as any)();
	check("removeApiKey deletes the stored key", deletedKeys.includes("promptImprover.apiKey"), deletedKeys);
	check(
		"removeApiKey clears the provider setting",
		state.config.get("promptImprover.userProvider") === undefined,
		state.config.get("promptImprover.userProvider")
	);
	check(
		"removeApiKey clears the model setting",
		state.config.get("promptImprover.userModel") === undefined,
		state.config.get("promptImprover.userModel")
	);
	check(
		"removeApiKey clears the baseUrl setting",
		state.config.get("promptImprover.userBaseUrl") === undefined,
		state.config.get("promptImprover.userBaseUrl")
	);
	check(
		"removeApiKey clears stored cloud consent",
		state.config.get("promptImprover.allowCloudFallback") === undefined,
		state.config.get("promptImprover.allowCloudFallback")
	);

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
