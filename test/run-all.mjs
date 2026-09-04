#!/usr/bin/env node
// Runs ALL project test suites with the right env vars and working directories.
// Usage from the PROJECT ROOT:
//   npm test            (recommended)
//   node test/run-all.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(root, "worker");

const tsxRoot = (file) => [
	"npx",
	"--no-install",
	"tsx",
	"--tsconfig",
	"test/tsconfig.json",
	`test/${file}`,
];

const suites = [
	{
		name: "LLM service — tiers, consent, timeouts, rate limit, quota",
		cwd: root,
		env: {},
		cmd: tsxRoot("llm-service.test.mts"),
	},
	{
		name: "Webview — error link & quota label",
		cwd: root,
		env: {},
		cmd: tsxRoot("webview-error-link.test.mts"),
	},
	{
		name: "Panel hidden mid-request — result stash",
		cwd: root,
		env: {},
		cmd: tsxRoot("pending-result.test.mts"),
	},
	{
		name: "Extension commands — cleanup & removeApiKey reset",
		cwd: root,
		env: {},
		cmd: tsxRoot("extension-commands.test.mts"),
	},
	...["Visual Studio Code", "Cursor", "Windsurf"].map((app) => ({
		name: `Chat handoff — ${app}`,
		cwd: root,
		env: { TEST_APP_NAME: app },
		cmd: tsxRoot("chat-handoff.test.mts"),
	})),
	{
		name: "Worker — proxy server",
		cwd: workerDir,
		env: {},
		cmd: ["npx", "--no-install", "tsx", "test-handler.mts"],
	},
];

let failedSuites = 0;
for (const suite of suites) {
	console.log(`\n=== ${suite.name} ===`);
	const [bin, ...args] = suite.cmd;
	const result = spawnSync(bin, args, {
		cwd: suite.cwd,
		env: { ...process.env, ...suite.env },
		stdio: "inherit",
		shell: true, // lets Windows resolve npx.cmd
	});
	if (result.status !== 0) failedSuites++;
}

if (failedSuites === 0) {
	console.log("\n✅ ALL SUITES PASSED");
} else {
	console.log(`\n❌ ${failedSuites} suite(s) failed`);
}
process.exit(failedSuites === 0 ? 0 : 1);
