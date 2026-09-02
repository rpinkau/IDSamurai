import * as vscode from 'vscode';
import { Config } from '../config';
import { WikiClient } from '../wiki-client';

export function registerTestConnectionCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel,
  onSuccess: () => void,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.testConnection', async () => {
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
        title: 'IDSamurai: Verbindungstest läuft...',
        cancellable: false,
      },
      async () => {
        try {
          const testPath = `/IDSamurai-ConnectionTest-${Date.now()}`;
          // 1. Schreiben (und falls vorhanden überschreiben)
          await client.writePage(testPath, 'Verbindungstest durch IDSamurai.');
          // 2. Wieder löschen
          await client.deletePage(testPath);
          
          vscode.window.showInformationMessage('IDS: Verbindungstest erfolgreich! Lese- und Schreibzugriff bestätigt.');
          onSuccess();
        } catch (e) {
          outputChannel.appendLine(`[FEHLER] Verbindungstest: ${e}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`IDSamurai: Verbindungstest fehlgeschlagen: ${e}`);
        }
      }
    );
  });
}
