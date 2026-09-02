import * as vscode from 'vscode';
import { Config } from '../config';
import { WikiClient } from '../wiki-client';
import { sync } from '../sync-engine';

export function registerDryRunCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.dryRun', async () => {
    const config = getConfig();
    if (!config) {
      vscode.window.showWarningMessage('IDSamurai: Keine .devops-wiki.json gefunden.', 'Erstellen').then(selection => {
        if (selection === 'Erstellen') {
          vscode.commands.executeCommand('ids.createConfigTemplate');
        }
      });
      return;
    }

    const client = getClient();
    if (!client) {
      vscode.window.showWarningMessage('IDSamurai: Kein PAT konfiguriert. Bitte "Wiki: PAT konfigurieren" ausführen.');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'IDSamurai Dry-Run (Vorschau)',
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const result = await sync(config, client, true, progress, token);

          outputChannel.clear();
          outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] IDSamurai Dry-Run Ergebnis (keine Änderungen wurden geschrieben)`);
          outputChannel.appendLine(`  +${result.added} neu  ~${result.updated} zu aktualisieren  -${result.removed} zu löschen  =${result.unchanged} unverändert`);
          outputChannel.appendLine('');
          for (const detail of result.details) {
            outputChannel.appendLine(`  ${detail}`);
          }
          outputChannel.show();

          const totalChanges = result.added + result.updated + result.removed;
          if (totalChanges === 0) {
            vscode.window.showInformationMessage('IDSamurai Dry-Run: Wiki ist aktuell — 0 Änderungen.');
          } else {
            vscode.window.showInformationMessage(
              `IDSamurai Dry-Run: ${totalChanges} Änderungen würden durchgeführt. Details im Output Channel.`
            );
          }
        } catch (e) {
          outputChannel.appendLine(`[FEHLER] Dry-Run: ${e}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`IDSamurai Dry-Run: Fehlgeschlagen: ${e}`);
        }
      }
    );
  });
}
