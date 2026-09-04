# Changelog

All notable changes to the **PromptPilot** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] - 2026-09-04

### Security
- **Hardened the free proxy**: system prompt now lives only on the server, CORS restricted to VS Code webviews, per-machine + per-IP + global daily limits, quota consumed only on success, request-size pre-filter (413).
- **Consent before cloud fallback**: if your own key/provider fails (including local Ollama), you are explicitly asked before a prompt is sent to the cloud proxy; `promptImprover.allowCloudFallback` persists an "always allow" choice.
- **Structured rate-limit contract**: `RATE_LIMITED` code + typed `RateLimitError` + `rateLimited` flag replace matching on message text; webview error rendering is DOM-safe (no innerHTML).
- **Safe chat handoff**: sending to the editor's AI chat no longer blind-pastes; the clipboard is written only when needed, always with a visible notice.

### Added
- **Network timeouts everywhere** (LLM 90s, quota 10s) — the Improve button can never spin forever; Tier-1 token sources are cancelled and disposed (leak fixed).
- **Result stash**: improved prompts that complete while the panel is hidden are kept and delivered on the next open — paid quota is never lost.
- **Dynamic quota badge**: shows the real server limit (`N/M`) instead of a hardcoded 30.
- **Anthropic `userBaseUrl`**: custom gateways/proxies now work for Anthropic too.
- **Remove Key button**: the panel shows a 🗑 Remove Key button whenever an own key is configured (with a confirmation dialog) — removing the key also clears provider settings and stored cloud consent.
- **Testing**: full offline suite — 8 suites, 142 checks via `npm test` — plus GitHub Actions CI on every push.

### Changed
- **Proxy model upgraded** to Llama 3.3 70B (`max_tokens` 4096, temp 0.25) with strict preservation rules — file names and line markers like `L4-21` are kept verbatim.
- **New sidebar icon** derived from `sidebar.jpg` as a transparent PNG (the opaque JPG rendered as a gray square in the activity bar).
- **Remove API Key** now also clears provider settings and stored cloud consent.

### Removed
- Dead `promptImprover.focus` command registration.

---

## [0.1.6] - 2026-08-22

### Fixed
- **Quota Reset on Reinstall Bug**: Fixed an issue where daily remaining prompt quota reset to 30 when uninstalling and reinstalling the extension. Added persistent `X-Machine-ID` header rate-limiting on the proxy server and automatic startup quota synchronization for the webview.

---

## [0.1.5] - 2026-08-22

### Added
- **Remaining Prompts Badge**: Displays daily remaining prompt count (e.g., `⚡ 29 free prompts remaining today`).
- **Nonsensical Input Validation**: Added strict validation against empty, repeated characters, or keyboard-mash gibberish (e.g. `djfhsjhgfjshgjuw`).

---

## [0.1.4] - 2026-08-22

### Fixed
- Fixed activity bar hover tooltip text from "Prompt Improver" to **"PromptPilot"**.
- Fixed activity bar gray square icon issue by converting to a theme-adaptive vector SVG (`sidebar.svg`).

---

## [0.1.3] - 2026-08-21

### Added
- Added screenshot preview image to `README.md`.
- Added `CHANGELOG.md` file.

---

## [0.1.2] - 2026-08-21

### Added
- New professional extension icon (`market.jpg`) and sidebar activity bar icon (`sidebar.jpg`).

### Changed
- Switched free proxy backend from Groq to Cloudflare Workers AI (`@cf/meta/llama-3.2-3b-instruct`) for 100% availability with zero external API keys and zero geo-blocking.

---

## [0.1.1] - 2026-08-21

### Added
- Added custom activity bar icon.
- Added MIT License file (`LICENSE.txt`).

---

## [0.1.0] - 2026-08-21

### Added
- Initial release of **PromptPilot**.
- 4 improvement presets: **Structure as task**, **More specific**, **Shorter**, **Add constraints**.
- 3-tier LLM engine fallback:
  1. VS Code Built-in Language Model API (`vscode.lm`).
  2. User's custom API Key (OpenAI, Anthropic, Groq, Ollama, Custom endpoint).
  3. Free hosted proxy (30 improvements/day).
- One-click **Send to chat** support for **VS Code Copilot Chat**, **Cursor Composer**, and **Windsurf Cascade**.
- Options for automatically appending **Implementation Plan** and **Git Commit** requirements.
- Secure key storage via VS Code `SecretStorage`.
- Keyboard shortcut `Ctrl+Alt+P` / `Cmd+Alt+P`.
