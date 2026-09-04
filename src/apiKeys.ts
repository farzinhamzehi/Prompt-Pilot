import * as vscode from "vscode";

/**
 * Removes the stored API key AND resets provider-related settings plus the
 * stored cloud-fallback consent, so no stale config silently steers future
 * requests after the key is gone. Shared by the Remove API Key command and
 * the panel's Remove Key button.
 */
export async function clearApiKeyAndSettings(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete("promptImprover.apiKey");
  const cfg = vscode.workspace.getConfiguration("promptImprover");
  await cfg.update("userProvider", undefined, vscode.ConfigurationTarget.Global);
  await cfg.update("userModel", undefined, vscode.ConfigurationTarget.Global);
  await cfg.update("userBaseUrl", undefined, vscode.ConfigurationTarget.Global);
  await cfg.update("allowCloudFallback", undefined, vscode.ConfigurationTarget.Global);
}
