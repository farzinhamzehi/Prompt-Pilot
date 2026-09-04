// Behavioral tests for chatHandoff — step 3: no blind paste, clipboard discipline.
// The editor identity is fixed at module load, so run one pass per editor:
//   TEST_APP_NAME="Visual Studio Code" npx tsx --tsconfig test/tsconfig.json test/chat-handoff.test.mts
//   TEST_APP_NAME=Cursor               npx tsx --tsconfig test/tsconfig.json test/chat-handoff.test.mts
//   TEST_APP_NAME=Windsurf             npx tsx --tsconfig test/tsconfig.json test/chat-handoff.test.mts

import * as vscode from "vscode";
import { sendToChat } from "../src/chatHandoff";

const state = (vscode as any).__state as {
	availableCommands: string[];
	failingCommands: Set<string>;
	executedCommands: { id: string; args: unknown[] }[];
	clipboardText: string | null;
	statusMessages: string[];
	infoMessages: string[];
};

const APP = ((globalThis as any).process?.env?.TEST_APP_NAME as string) ?? "Visual Studio Code";

const OPENAGENT = "workbench.action.chat.openagent";
const CHAT_OPEN = "workbench.action.chat.open";
const PASTE = "editor.action.clipboardPasteAction";

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

function reset() {
	state.availableCommands = [];
	state.failingCommands = new Set();
	state.executedCommands = [];
	state.clipboardText = null;
	state.statusMessages = [];
	state.infoMessages = [];
}

const ran = (id: string) => state.executedCommands.some((c) => c.id === id);
const ranWith = (id: string) => state.executedCommands.filter((c) => c.id === id);

async function vscodeSuite() {
	// 1. openagent present -> query-passing, clipboard untouched, no blind paste
	reset();
	state.availableCommands = [OPENAGENT];
	await sendToChat("hello prompt");
	const call = ranWith(OPENAGENT)[0];
	check("vscode: openagent executed", !!call);
	check("vscode: isPartialQuery=true (no auto-submit)", (call?.args?.[0] as any)?.isPartialQuery === true, call?.args);
	check("vscode: clipboard NOT touched on query path", state.clipboardText === null);
	check("vscode: no blind paste command", !ran(PASTE));

	// 2. openagent throws -> legacy chat.open WITHOUT a query arg + clipboard handoff
	reset();
	state.availableCommands = [OPENAGENT, CHAT_OPEN];
	state.failingCommands = new Set([OPENAGENT]);
	await sendToChat("legacy prompt");
	const open = ranWith(CHAT_OPEN)[0];
	check("vscode legacy: chat.open executed", !!open);
	check("vscode legacy: chat.open called with NO query argument", !!open && open.args.length === 0, open?.args);
	check("vscode legacy: clipboard holds the prompt", state.clipboardText === "legacy prompt");
	check("vscode legacy: no blind paste command", !ran(PASTE));

	// 3. no chat commands at all -> pure clipboard fallback + info message
	reset();
	await sendToChat("fallback prompt");
	check("vscode fallback: clipboard holds the prompt", state.clipboardText === "fallback prompt");
	check("vscode fallback: info message shown", state.infoMessages.length === 1);
	check("vscode fallback: no paste command", !ran(PASTE));
}

async function cursorSuite() {
	// 4. composer command present -> panel opened, clipboard written, NO blind paste
	reset();
	state.availableCommands = ["composer.newAgentChat"];
	await sendToChat("cursor prompt");
	check("cursor: composer opened", ran("composer.newAgentChat"));
	check("cursor: clipboard holds the prompt for manual paste", state.clipboardText === "cursor prompt");
	check("cursor: NO blind paste into the focused element", !ran(PASTE));
	check("cursor: user is told to paste", state.statusMessages.some((m) => m.includes("Ctrl+V")), state.statusMessages);

	// 5. query-capable openagent present in Cursor -> prefill, clipboard untouched
	reset();
	state.availableCommands = [OPENAGENT];
	await sendToChat("cursor query prompt");
	check("cursor: openagent query path used", (ranWith(OPENAGENT)[0]?.args?.[0] as any)?.query === "cursor query prompt", state.executedCommands);
	check("cursor: clipboard untouched on query path", state.clipboardText === null);
}

async function windsurfSuite() {
	// 6. cascade command present -> opened, clipboard written at need-time, no paste
	reset();
	state.availableCommands = ["windsurf.cascade.focus"];
	await sendToChat("windsurf prompt");
	check("windsurf: cascade opened", ran("windsurf.cascade.focus"));
	check("windsurf: clipboard written (only when needed)", state.clipboardText === "windsurf prompt");
	check("windsurf: NO blind paste", !ran(PASTE));

	// 7. query-capable command present -> clipboard stays untouched
	//    (the OLD code clobbered the clipboard unconditionally before checking)
	reset();
	state.availableCommands = [OPENAGENT];
	await sendToChat("windsurf query");
	check("windsurf query path: clipboard untouched", state.clipboardText === null);

	// 8. nothing available -> pure clipboard fallback, no commands executed
	reset();
	await sendToChat("windsurf fallback");
	check("windsurf fallback: clipboard holds prompt", state.clipboardText === "windsurf fallback");
	check("windsurf fallback: no commands executed", state.executedCommands.length === 0);
	check("windsurf fallback: info message shown", state.infoMessages.length === 1);
}

async function main() {
	console.log(`=== editor under test: ${APP} ===`);
	if (APP === "Visual Studio Code") {
		await vscodeSuite();
	} else if (APP === "Cursor") {
		await cursorSuite();
	} else if (APP === "Windsurf") {
		await windsurfSuite();
	} else {
		console.log("unknown TEST_APP_NAME — no suite matched");
	}
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
