// ---------------------------------------------------------------------------
// Minimal but faithful mock of the `vscode` API surface used by this project.
// Serves two purposes:
//   1. Offline type-checking: `tsc -p test/tsconfig.json` maps "vscode" here.
//   2. Runtime behavior tests: `npx tsx --tsconfig test/tsconfig.json ...`
//      resolves the same mapping, so LlmService talks to this mock.
// Test-visible state lives in `__state` (shared module instance).
// ---------------------------------------------------------------------------

export type Thenable<T> = PromiseLike<T>;

export interface Disposable {
	dispose(): void;
}

export interface SecretStorage {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

export interface Memento {
	get(key: string): unknown;
	update(key: string, value: unknown): Thenable<void>;
}

export interface ExtensionContext {
	subscriptions: Disposable[];
	secrets: SecretStorage;
	workspaceState: Memento;
	globalState: Memento;
}

export enum ConfigurationTarget {
	Global = 1,
	Workspace = 2,
	WorkspaceFolder = 3,
}

export interface WorkspaceConfiguration {
	get<T>(section: string): T | undefined;
	update(section: string, value: unknown, target?: ConfigurationTarget): Thenable<void>;
}

export interface WebviewOptions {
	enableScripts?: boolean;
}

export interface Webview {
	options: WebviewOptions;
	html: string;
	postMessage(message: unknown): Thenable<boolean>;
	onDidReceiveMessage(listener: (message: any) => unknown): Disposable;
}

export interface WebviewView {
	webview: Webview;
}

export interface WebviewViewProvider {
	resolveWebviewView(view: WebviewView): void;
}

export interface QuickPickItem {
	label: string;
	description?: string;
}

export interface MessageOptions {
	modal?: boolean;
	detail?: string;
}

// ---- mutable test state (shared by the test file and the code under test) ----

export const __state = {
	config: new Map<string, unknown>(),
	warningResponses: [] as (string | undefined)[],
	warningCalls: [] as { message: string; options?: MessageOptions; items: string[] }[],
	infoMessages: [] as string[],
	lmModels: [] as unknown[],
	lmCalls: 0,
};

export const workspace = {
	getConfiguration(section?: string): WorkspaceConfiguration {
		return {
			get: <T>(key: string): T | undefined =>
				__state.config.get(`${section}.${key}`) as T | undefined,
			update: async (key: string, value: unknown): Promise<void> => {
				__state.config.set(`${section}.${key}`, value);
			},
		};
	},
};

export const window = {
	registerWebviewViewProvider(
		_id: string,
		_provider: WebviewViewProvider,
		_options?: unknown
	): Disposable {
		return { dispose() {} };
	},
	showQuickPick: async (..._args: unknown[]): Promise<any> => undefined,
	showInputBox: async (..._args: unknown[]): Promise<string | undefined> => undefined,
	showInformationMessage: async (
		message: string,
		..._items: unknown[]
	): Promise<string | undefined> => {
		__state.infoMessages.push(message);
		return undefined;
	},
	showWarningMessage: async (
		message: string,
		options?: MessageOptions,
		...items: string[]
	): Promise<string | undefined> => {
		__state.warningCalls.push({ message, options, items });
		return __state.warningResponses.shift();
	},
	setStatusBarMessage: (_message: string, _hideAfterMs?: number): Disposable => ({
		dispose() {},
	}),
};

export const commands = {
	registerCommand(_id: string, _handler: (...args: unknown[]) => unknown): Disposable {
		return { dispose() {} };
	},
	executeCommand: async <T = unknown>(_id: string, ..._args: unknown[]): Promise<T | undefined> =>
		undefined,
	getCommands: async (_filterInternal?: boolean): Promise<string[]> => [],
};

export const env = {
	appName: "Visual Studio Code",
	machineId: "test-machine-1",
	clipboard: {
		writeText: async (_text: string): Promise<void> => {},
	},
};

export class CancellationTokenSource {
	token = { isCancellationRequested: false };
	cancel(): void {}
	dispose(): void {}
}

// `lm` mirrors VS Code >= 1.90. LlmService probes availability and falls back
// cleanly when no models are returned (empty array = "no Copilot models").
export const lm: unknown = {
	selectChatModels: async (_filter: unknown): Promise<unknown[]> => {
		__state.lmCalls++;
		return __state.lmModels;
	},
};

export const LanguageModelChatMessage = {
	User: (content: string) => ({ role: "user" as const, content }),
};
