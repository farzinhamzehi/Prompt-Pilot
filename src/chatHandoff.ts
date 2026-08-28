import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Detect which editor we are running in at startup (cached — never changes)
// ---------------------------------------------------------------------------
const appName = vscode.env.appName.toLowerCase();
const isCursor = appName.includes("cursor");
const isWindsurf = appName.includes("windsurf");

// ---------------------------------------------------------------------------
// Note: the command list is intentionally NOT cached. Chat-related extensions
// (Copilot Chat, Composer, Cascade) can be installed or enabled mid-session,
// and a stale cache would never see their commands. Enumeration is a cheap
// in-memory operation that only happens on an explicit user click.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sendToChat
//
// Goal: open the AI chat panel of the current editor and INSERT the prompt
//       into the input field WITHOUT auto-submitting. User reviews + presses Enter.
//
// Safety rules (step-3 hardening):
//  - NEVER execute a blind "paste" into whatever element happens to have
//    focus. A fixed-delay programmatic paste could inject the prompt into the
//    user's source code if the chat input was not focused yet. Instead, when
//    no query-capable command exists, we put the prompt on the clipboard and
//    tell the user to paste it (Ctrl+V / Cmd+V).
//  - The clipboard is written ONLY when the clipboard path is actually used,
//    and the user is always told when that happens.
//  - "chat.open" with a raw string argument is avoided: its behavior varies
//    across versions and may auto-submit, violating the no-auto-submit rule.
// ---------------------------------------------------------------------------
export async function sendToChat(prompt: string): Promise<void> {
  const all = await vscode.commands.getCommands(true);
  const has = (id: string) => all.includes(id);

  if (isCursor) {
    await sendToCursor(prompt, has);
    return;
  }
  if (isWindsurf) {
    await sendToWindsurf(prompt, has);
    return;
  }
  await sendToVSCode(prompt, has);
}

// ---------------------------------------------------------------------------
// VS Code
// ---------------------------------------------------------------------------
async function sendToVSCode(
  prompt: string,
  has: (id: string) => boolean
): Promise<void> {
  // Best: openagent with isPartialQuery:true → puts text in input, no auto-submit
  if (has("workbench.action.chat.openagent")) {
    try {
      await vscode.commands.executeCommand("workbench.action.chat.openagent", {
        query: prompt,
        isPartialQuery: true, // ← prevents auto-submit
        focus: true,
      });
      vscode.window.setStatusBarMessage(
        "✨ Prompt loaded in Copilot Chat — press Enter to send",
        4000
      );
      return;
    } catch {
      /* fall through */
    }
  }

  // Legacy path: open the chat panel EMPTY and hand the prompt via clipboard.
  if (has("workbench.action.chat.open")) {
    try {
      await vscode.env.clipboard.writeText(prompt);
      await vscode.commands.executeCommand("workbench.action.chat.open");
      vscode.window.setStatusBarMessage(
        "✨ Chat opened — paste the prompt with Ctrl+V (already on your clipboard)",
        6000
      );
      return;
    } catch {
      /* fall through */
    }
  }

  await clipboardFallback(prompt);
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------
async function sendToCursor(
  prompt: string,
  has: (id: string) => boolean
): Promise<void> {
  const openCmds = [
    "composer.newAgentChat",
    "composer.startComposerPrompt",
    "aichat.newchataction",
    "aichat.show-ai-chat",
    "workbench.action.chat.openagent",
    "workbench.action.chat.open",
  ];

  const openCmd = openCmds.find(has);

  if (openCmd) {
    try {
      // 1. Query-capable command → prefill directly; clipboard untouched
      if (openCmd.includes("chat.open")) {
        await vscode.commands.executeCommand(openCmd, {
          query: prompt,
          isPartialQuery: true,
          focus: true,
        });
        vscode.window.setStatusBarMessage(
          "✨ Prompt loaded — press Enter to send",
          4000
        );
        return;
      }

      // 2. Composer-specific: open the panel, then clipboard + user pastes.
      //    No blind programmatic paste — it could land in a source file.
      await vscode.env.clipboard.writeText(prompt);
      await vscode.commands.executeCommand(openCmd);
      vscode.window.setStatusBarMessage(
        "✨ Composer opened — paste with Ctrl+V (prompt is on your clipboard)",
        6000
      );
      return;
    } catch {
      /* fall through */
    }
  }

  await clipboardFallback(prompt);
}

// ---------------------------------------------------------------------------
// Windsurf
// ---------------------------------------------------------------------------
async function sendToWindsurf(
  prompt: string,
  has: (id: string) => boolean
): Promise<void> {
  const cascadeCmds = [
    "windsurf.cascade.focus",
    "windsurf.openCascade",
    "codeium.openCascade",
    "workbench.action.chat.openagent",
    "workbench.action.chat.open",
  ];

  const openCmd = cascadeCmds.find(has);

  if (openCmd) {
    try {
      if (openCmd.includes("chat.open")) {
        await vscode.commands.executeCommand(openCmd, {
          query: prompt,
          isPartialQuery: true,
          focus: true,
        });
        vscode.window.setStatusBarMessage(
          "✨ Prompt loaded — press Enter to send",
          4000
        );
      } else {
        // Clipboard is written ONLY here, when it is actually needed
        await vscode.env.clipboard.writeText(prompt);
        await vscode.commands.executeCommand(openCmd);
        vscode.window.setStatusBarMessage(
          "✨ Cascade opened — paste with Ctrl+V (prompt is on your clipboard)",
          6000
        );
      }
      return;
    } catch {
      /* fall through */
    }
  }

  await clipboardFallback(prompt);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function clipboardFallback(prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    "✨ Prompt copied — open your AI chat and paste with Ctrl+V (or Cmd+V)."
  );
}
