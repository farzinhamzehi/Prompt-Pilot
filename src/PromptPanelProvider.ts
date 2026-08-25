import * as vscode from "vscode";
import { sendToChat } from "./chatHandoff";
import { LlmService } from "./llm/LlmService";
import { PresetId, PRESETS, validatePrompt } from "./core/improvementEngine";

interface ImproveOptions {
  implementationPlan: boolean;
  commitChanges: boolean;
  pushCommits: boolean;
}

type WebviewMsg =
  | { type: "improve"; prompt: string; preset: PresetId; options: ImproveOptions }
  | { type: "send"; prompt: string }
  | { type: "copy"; prompt: string }
  | { type: "setKey" };

// ---------------------------------------------------------------------------
// Appends deterministic instructions to the improved prompt based on checkboxes
// ---------------------------------------------------------------------------
function applyOptions(improved: string, options: ImproveOptions): string {
  const sections: string[] = [improved.trimEnd()];

  if (options.implementationPlan) {
    sections.push(
      `\n## Before Starting\n` +
      `Before writing any code:\n` +
      `1. Analyze the relevant files, architecture, and dependencies.\n` +
      `2. Create a detailed implementation plan (files to change, approach, risks).\n` +
      `3. Present the plan and wait for approval before making any changes.`
    );
  }

  if (options.commitChanges) {
    const pushLine = options.pushCommits
      ? `\n3. Push the committed changes to the remote repository.`
      : "";
    sections.push(
      `\n## After Completion\n` +
      `After the implementation is complete and validated:\n` +
      `1. Stage all changed files.\n` +
      `2. Commit with a descriptive message summarizing what was implemented and why.` +
      pushLine
    );
  }

  return sections.join("\n");
}

export class PromptPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "promptImprover.panel";
  private readonly llm: LlmService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.llm = new LlmService(context);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);

    // Fetch current remaining quota for this machine ID asynchronously and sync UI
    void this.llm.getQuota().then((remaining) => {
      if (typeof remaining === "number") {
        void view.webview.postMessage({ type: "quota", remaining });
      }
    });

    view.webview.onDidReceiveMessage(async (msg: WebviewMsg) => {
      switch (msg.type) {
        case "improve": {
          const validation = validatePrompt(msg.prompt);
          if (!validation.valid) {
            view.webview.postMessage({
              type: "error",
              message: validation.error,
            });
            break;
          }

          try {
            const result = await this.llm.improve(msg.prompt, msg.preset);
            const improved = applyOptions(result.improved, msg.options);
            view.webview.postMessage({
              type: "result",
              improved,
              remaining: result.remaining,
            });
          } catch (err) {
            view.webview.postMessage({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case "send":
          await sendToChat(msg.prompt);
          break;
        case "copy":
          await vscode.env.clipboard.writeText(msg.prompt);
          vscode.window.setStatusBarMessage("Prompt copied ✓", 2000);
          break;
        case "setKey":
          await vscode.commands.executeCommand("promptImprover.setApiKey");
          break;
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);

    const presetButtons = (Object.entries(PRESETS) as [PresetId, { label: string }][])
      .map(
        ([id, { label }]) =>
          `<button class="preset" data-preset="${id}">${label}</button>`
      )
      .join("\n    ");

    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 10px;
    margin: 0;
  }
  label {
    display: block;
    font-size: 11px;
    opacity: .75;
    text-transform: uppercase;
    letter-spacing: .05em;
    margin-bottom: 4px;
  }
  textarea {
    width: 100%;
    resize: vertical;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 6px;
    font-family: inherit;
    font-size: 13px;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }

  /* Preset strip */
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 8px 0 6px;
  }
  .preset {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    cursor: pointer;
    opacity: .85;
    transition: opacity .15s;
  }
  .preset:hover { opacity: 1; }
  .preset.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    opacity: 1;
  }

  /* Checkbox options */
  .options {
    margin: 8px 0 6px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .option-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
  }
  .option-row input[type="checkbox"] {
    width: 13px;
    height: 13px;
    cursor: pointer;
    accent-color: var(--vscode-button-background);
    flex-shrink: 0;
  }
  .option-row span { line-height: 1; }

  /* Push row indented under commit */
  .option-sub {
    padding-left: 19px;
  }
  .option-sub.hidden { display: none; }

  /* Divider */
  .divider {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, rgba(255,255,255,.1));
    margin: 8px 0;
  }

  /* Action buttons */
  .actions { display: flex; gap: 6px; margin: 8px 0 4px; flex-wrap: wrap; }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.primary:disabled { opacity: .5; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
  }
  button.secondary:hover { opacity: .85; }

  /* Status + error + quota */
  #status { font-size: 11px; opacity: .65; min-height: 14px; margin-top: 4px; }
  #quota {
    display: block;
    margin-top: 6px;
    padding: 5px 8px;
    border-radius: 4px;
    font-size: 11px;
    background: var(--vscode-badge-background, rgba(255,255,255,.07));
    color: var(--vscode-badge-foreground, inherit);
    opacity: .9;
  }
  #error {
    display: none;
    margin-top: 6px;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 12px;
    background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
    color: var(--vscode-errorForeground);
    line-height: 1.4;
  }
  #error a {
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }

  .row { margin-bottom: 8px; }

  /* Spinner */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
</style>
</head>
<body>

  <div class="row">
    <label>Your prompt</label>
    <textarea id="input" rows="6" placeholder="Write your rough prompt here…"></textarea>
  </div>

  <div class="presets">
    ${presetButtons}
  </div>

  <hr class="divider" />

  <!-- ── Options checkboxes ───────────────────────────────────────────── -->
  <div class="options">
    <label class="option-row">
      <input type="checkbox" id="opt-plan" checked />
      <span>Create implementation plan</span>
    </label>
    <label class="option-row">
      <input type="checkbox" id="opt-commit" />
      <span>Commit changes after end</span>
    </label>
    <div class="option-sub hidden" id="push-row">
      <label class="option-row">
        <input type="checkbox" id="opt-push" />
        <span>Push commits after end</span>
      </label>
    </div>
  </div>

  <hr class="divider" />

  <div class="actions">
    <button id="improve" class="primary">✨ Improve</button>
  </div>

  <div class="row">
    <label>Improved <span style="opacity:.5;font-weight:400;text-transform:none">(editable)</span></label>
    <textarea id="output" rows="10" placeholder="Improved prompt appears here…"></textarea>
  </div>

  <div class="actions">
    <button id="send" class="primary">➤ Send to chat</button>
    <button id="copy" class="secondary">Copy</button>
    <button id="setKey" class="secondary" title="Add your own API key for unlimited use">🔑 API Key</button>
  </div>

  <div id="status"></div>
  <div id="quota">⚡ 30/30 remaining prompts</div>
  <div id="error"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);

  // ── State restore ──────────────────────────────────────────────────────────
  let selectedPreset = "structured";
  const prev = vscode.getState();
  if (prev) {
    $("input").value        = prev.input  || "";
    $("output").value       = prev.output || "";
    selectedPreset          = prev.preset || "structured";
    $("opt-plan").checked   = prev.optPlan   !== false; // default true
    $("opt-commit").checked = !!prev.optCommit;
    $("opt-push").checked   = !!prev.optPush;
    if (prev.optCommit) $("push-row").classList.remove("hidden");
    if (prev.quotaText) $("quota").textContent = prev.quotaText;
  }

  const save = () => vscode.setState({
    input:     $("input").value,
    output:    $("output").value,
    preset:    selectedPreset,
    optPlan:   $("opt-plan").checked,
    optCommit: $("opt-commit").checked,
    optPush:   $("opt-push").checked,
    quotaText: $("quota").textContent,
  });

  $("input").addEventListener("input",  save);
  $("output").addEventListener("input", save);

  // ── Preset buttons ─────────────────────────────────────────────────────────
  document.querySelectorAll(".preset").forEach(btn => {
    if (btn.dataset.preset === selectedPreset) btn.classList.add("active");
    btn.addEventListener("click", () => {
      document.querySelectorAll(".preset").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedPreset = btn.dataset.preset;
      save();
    });
  });

  // ── Checkbox logic ─────────────────────────────────────────────────────────
  $("opt-plan").addEventListener("change",   save);
  $("opt-push").addEventListener("change",   save);
  $("opt-commit").addEventListener("change", () => {
    // Show/hide push row depending on commit checkbox
    if ($("opt-commit").checked) {
      $("push-row").classList.remove("hidden");
    } else {
      $("push-row").classList.add("hidden");
      $("opt-push").checked = false;
    }
    save();
  });

  // ── Improve ────────────────────────────────────────────────────────────────
  function setLoading(on) {
    const btn = $("improve");
    if (on) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Improving…';
    } else {
      btn.disabled = false;
      btn.innerHTML = "✨ Improve";
    }
    $("error").style.display = "none";
    $("status").textContent = "";
  }

  $("improve").onclick = () => {
    const prompt = $("input").value.trim();
    if (!prompt) return;
    setLoading(true);
    vscode.postMessage({
      type:   "improve",
      prompt,
      preset: selectedPreset,
      options: {
        implementationPlan: $("opt-plan").checked,
        commitChanges:      $("opt-commit").checked,
        pushCommits:        $("opt-push").checked,
      },
    });
  };

  // ── Send / Copy ────────────────────────────────────────────────────────────
  $("send").onclick = () => {
    const prompt = ($("output").value || $("input").value).trim();
    if (prompt) vscode.postMessage({ type: "send", prompt });
  };
  $("copy").onclick = () => {
    const prompt = ($("output").value || $("input").value).trim();
    if (prompt) vscode.postMessage({ type: "copy", prompt });
  };
  $("setKey").onclick = () => vscode.postMessage({ type: "setKey" });

  // ── Messages from host ─────────────────────────────────────────────────────
  window.addEventListener("message", e => {
    const msg = e.data;
    if (msg.type === "quota") {
      if (typeof msg.remaining === "number") {
        $("quota").textContent = "⚡ " + msg.remaining + "/30 remaining prompts";
        save();
      }
    } else if (msg.type === "result") {
      $("output").value = msg.improved;
      if (typeof msg.remaining === "number") {
        $("quota").textContent = "⚡ " + msg.remaining + "/30 remaining prompts";
      }
      setLoading(false);
      save();
    } else if (msg.type === "error") {
      setLoading(false);
      const errDiv = $("error");
      if (msg.message && msg.message.includes("limit reached")) {
        errDiv.innerHTML = msg.message +
          ' <a onclick="document.getElementById(\\'setKey\\').click()">Add your own key →</a>';
      } else {
        errDiv.textContent = msg.message || "An error occurred.";
      }
      errDiv.style.display = "block";
    }
  });
</script>
</body>
</html>`;
  }
}