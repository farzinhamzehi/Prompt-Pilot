import * as vscode from "vscode";
import { PromptPanelProvider } from "./PromptPanelProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new PromptPanelProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PromptPanelProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: false } }
    ),

    // ── Set API Key command ──────────────────────────────────────────────────
    vscode.commands.registerCommand(
      "promptImprover.setApiKey",
      async () => {
        const provider = await vscode.window.showQuickPick(
          [
            { label: "$(hubot) OpenAI",     description: "gpt-4o-mini, gpt-4o, …",             value: "openai"    },
            { label: "$(hubot) Groq",        description: "llama-3.1-8b-instant, …",             value: "groq"      },
            { label: "$(hubot) Anthropic",   description: "claude-3-5-haiku-latest, …",          value: "anthropic" },
            { label: "$(server) Ollama",     description: "Local — http://localhost:11434",       value: "ollama"    },
            { label: "$(globe) Custom URL",  description: "Any OpenAI-compatible endpoint",       value: "custom"    },
          ],
          { placeHolder: "Select your API provider", title: "Prompt Improver — Add API Key" }
        );
        if (!provider) return;

        // For custom/ollama also ask for base URL
        if (provider.value === "custom" || provider.value === "ollama") {
          const defaultUrl =
            provider.value === "ollama"
              ? "http://localhost:11434/v1"
              : "https://your-endpoint.com/v1";
          const baseUrl = await vscode.window.showInputBox({
            prompt: "Enter the API base URL",
            value: defaultUrl,
            ignoreFocusOut: true,
          });
          if (baseUrl) {
            await vscode.workspace
              .getConfiguration("promptImprover")
              .update("userBaseUrl", baseUrl, vscode.ConfigurationTarget.Global);
          }
        }

        // For ollama, no key needed — just set the provider and done
        if (provider.value === "ollama") {
          await vscode.workspace
            .getConfiguration("promptImprover")
            .update("userProvider", "ollama", vscode.ConfigurationTarget.Global);
          // Store a dummy key so LlmService knows to use Tier 2
          await context.secrets.store("promptImprover.apiKey", "ollama-no-key");
          vscode.window.showInformationMessage(
            "Ollama configured ✅ — make sure Ollama is running locally."
          );
          return;
        }

        const apiKey = await vscode.window.showInputBox({
          prompt: `Paste your ${provider.label.replace(/^\$\([^)]+\)\s*/, "")} API key`,
          password: true,
          placeHolder: "sk-…",
          ignoreFocusOut: true,
        });
        if (!apiKey) return;

        await context.secrets.store("promptImprover.apiKey", apiKey);
        await vscode.workspace
          .getConfiguration("promptImprover")
          .update("userProvider", provider.value, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage(
          `API key saved securely ✅ — Prompt Improver will now use ${provider.label.replace(/^\$\([^)]+\)\s*/, "")}.`
        );
      }
    ),

    // ── Remove API Key command ───────────────────────────────────────────────
    vscode.commands.registerCommand("promptImprover.removeApiKey", async () => {
      await context.secrets.delete("promptImprover.apiKey");
      // Also clear provider prefs + stored cloud-fallback consent so no stale
      // config silently steers future requests after the key is gone.
      const cfg = vscode.workspace.getConfiguration("promptImprover");
      await cfg.update("userProvider", undefined, vscode.ConfigurationTarget.Global);
      await cfg.update("userModel", undefined, vscode.ConfigurationTarget.Global);
      await cfg.update("userBaseUrl", undefined, vscode.ConfigurationTarget.Global);
      await cfg.update("allowCloudFallback", undefined, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        "API key and provider settings removed. Prompt Improver will use the free proxy."
      );
    })
  );
}

export function deactivate() {}