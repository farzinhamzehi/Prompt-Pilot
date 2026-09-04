// Regression test for the rate-limit error link ("Add your own key →").
//
// Background: the link used to be injected via innerHTML with an inline
// `onclick` attribute. The webview CSP is `script-src 'nonce-…'` WITHOUT
// 'unsafe-inline', and per CSP, inline event-handler attributes count as
// inline script — so the handler was blocked and the link was dead.
// The fix builds the link with DOM APIs and registers the listener from
// inside the nonced script, which CSP allows.
//
// This test executes the REAL inline script from PromptPanelProvider.html()
// against a minimal DOM mock and asserts the fixed behavior end to end.
//
// Run from the PROJECT ROOT:
//   npx tsx --tsconfig test/tsconfig.json test/webview-error-link.test.mts

import { PromptPanelProvider } from "../src/PromptPanelProvider";

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

// ── Minimal DOM mock — just enough surface for the panel script ────────────

interface MockEl {
	id: string;
	value: string;
	checked: boolean;
	disabled: boolean;
	textContent: string;
	innerHTML: string;
	style: Record<string, string>;
	dataset: Record<string, string>;
	children: MockEl[];
	classList: { add(): void; remove(): void };
	onclick: null | (() => void);
	addEventListener(ev: string, fn: (e?: unknown) => void): void;
	appendChild(child: MockEl): void;
	click(): void;
	listenerCount(ev: string): number;
}

function makeEl(id: string): MockEl {
	const listeners: Record<string, ((e?: unknown) => void)[]> = {};
	return {
		id,
		value: "",
		checked: false,
		disabled: false,
		textContent: "",
		innerHTML: "",
		style: {} as Record<string, string>,
		dataset: {} as Record<string, string>,
		children: [] as MockEl[],
		classList: { add() {}, remove() {} },
		onclick: null as null | (() => void),
		addEventListener(ev: string, fn: (e?: unknown) => void) {
			(listeners[ev] ||= []).push(fn);
		},
		appendChild(child: MockEl) {
			this.children.push(child);
		},
		click() {
			for (const fn of listeners.click ?? []) fn();
			this.onclick?.();
		},
		listenerCount(ev: string) {
			return (listeners[ev] ?? []).length;
		},
	};
}

const IDS = [
	"input", "output", "opt-plan", "opt-commit", "opt-push", "push-row",
	"improve", "send", "copy", "setKey", "removeKey", "status", "quota", "error",
];
const els: Record<string, MockEl> = Object.fromEntries(IDS.map((id) => [id, makeEl(id)]));

const documentMock = {
	getElementById: (id: string) => els[id],
	querySelectorAll: () => [] as unknown[],
	createElement: (tag: string) => makeEl(tag),
};

let messageHandler: ((e: { data: unknown }) => void) | null = null;
const windowMock = {
	addEventListener: (ev: string, fn: (e: { data: unknown }) => void) => {
		if (ev === "message") messageHandler = fn;
	},
};

const posted: unknown[] = [];
const vscodeApiMock = {
	getState: () => null,
	setState: () => {},
	postMessage: (m: unknown) => posted.push(m),
};

// ── Get the REAL webview HTML from the provider ────────────────────────────

// The provider fires an async quota GET on resolve; keep it offline.
(globalThis as any).fetch = async () => {
	throw new Error("offline in test");
};

const memento = { get: () => undefined, update: async () => {} };
const ctx = {
	secrets: {
		get: async () => undefined,
		store: async () => {},
		delete: async () => {},
	},
	// resolveWebviewView now reads the pending-result stash from workspaceState.
	workspaceState: memento,
	globalState: memento,
};
const provider = new PromptPanelProvider(ctx as any);

const webview = {
	options: {} as Record<string, unknown>,
	html: "",
	postMessage: async () => true,
	onDidReceiveMessage: () => ({ dispose() {} }),
};
provider.resolveWebviewView({ webview } as any);
const html = webview.html;

check("provider produced webview HTML", html.length > 1000);

const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
check("nonced script block found in HTML", !!scriptMatch);

// Structural guard: no inline event-handler attributes anywhere in the HTML.
// (Inline handlers are the class of bug this regression came from.)
check(
	"no inline event-handler attributes in generated HTML",
	!/[\s<]on(click|dblclick|error|load|focus|blur|input|change|submit|mouseover|keydown)\s*=\s*["']/i.test(html),
	html.match(/[\s<]on\w+\s*=\s*["']/gi)
);

// ── Execute the real panel script against the DOM mock ─────────────────────

const acquireVsCodeApiMock = () => vscodeApiMock;
const runScript = new Function("window", "document", "acquireVsCodeApi", scriptMatch![1]);
runScript(windowMock, documentMock, acquireVsCodeApiMock);

check("panel script registered a window message handler", typeof messageHandler === "function");

const errDiv = els.error;
const LIMIT_MSG =
	"Free tier limit reached (30 requests/day). Add your own API key in Prompt Improver settings for unlimited use.";

// Scenario 1: rate-limit error → server text via textContent + DOM-built link
messageHandler!({ data: { type: "error", message: LIMIT_MSG, rateLimited: true } });

check("error box becomes visible", errDiv.style.display === "block");
check("server message rendered via textContent (injection-safe)", errDiv.textContent.includes("limit reached"));
check("innerHTML never used for the error path", errDiv.innerHTML === "");
check("exactly one child (the link) appended", errDiv.children.length === 1, errDiv.children.length);

const link = errDiv.children[0];
check(
	"appended child is an <a> labelled 'Add your own key →'",
	link.id === "a" && link.textContent === "Add your own key →",
	link.textContent
);
check(
	"link uses addEventListener (CSP-safe), not an inline attribute",
	link.listenerCount("click") === 1
);

// Scenario 2: clicking the link activates the existing 🔑 API Key button,
// which posts {type:"setKey"} to the host (opens the Set API Key flow).
posted.length = 0;
link.click();
check(
	"clicking the link posts {type:'setKey'} to the host",
	posted.some((m) => (m as any)?.type === "setKey"),
	posted
);

// Scenario 3: non-limit errors stay plain text, no link appended
errDiv.children.length = 0;
messageHandler!({ data: { type: "error", message: "Proxy error 500. Please try again." } });
check(
	"non-limit error renders as plain text with no link",
	errDiv.textContent === "Proxy error 500. Please try again." && errDiv.children.length === 0
);

// Scenario 3b: the structured flag — not the message text — controls the link.
// The same legacy phrase WITHOUT the flag must render as plain text only.
errDiv.children.length = 0;
messageHandler!({ data: { type: "error", message: LIMIT_MSG } }); // no rateLimited flag
check(
	"legacy phrase without the structured flag gets no link",
	errDiv.textContent.includes("limit reached") && errDiv.children.length === 0
);

// Scenario 4: hostile server text cannot inject markup through this path
errDiv.children.length = 0;
const hostile = 'limit reached <img src=x onerror="window.__pwned=1">';
messageHandler!({ data: { type: "error", message: hostile } });
check(
	"hostile markup is stored as inert text, never as HTML",
	errDiv.innerHTML === "" && errDiv.textContent.includes("<img"),
	errDiv.innerHTML
);

// Scenario 5: dynamic quota label — uses the server-provided limit when present
messageHandler!({ data: { type: "quota", remaining: 5, limit: 12 } });
check(
	"quota message with limit renders 'N/M'",
	els.quota.textContent === "⚡ 5/12 remaining prompts",
	els.quota.textContent
);

// Scenario 6: quota without a limit (older server) renders without a total
messageHandler!({ data: { type: "quota", remaining: 5 } });
check(
	"quota message without limit renders 'N' only",
	els.quota.textContent === "⚡ 5 remaining prompts",
	els.quota.textContent
);

// Scenario 7: keystate toggles the Remove Key button; clicking it posts removeKey
messageHandler!({ data: { type: "keystate", hasKey: true } });
check(
	"keystate=true shows the Remove Key button",
	els.removeKey.style.display === "inline-block",
	els.removeKey.style.display
);
els.removeKey.click();
check(
	"Remove Key click posts {type:'removeKey'} to the host",
	posted.some((m: any) => m?.type === "removeKey"),
	posted
);
messageHandler!({ data: { type: "keystate", hasKey: false } });
check(
	"keystate=false hides the Remove Key button",
	els.removeKey.style.display === "none",
	els.removeKey.style.display
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
