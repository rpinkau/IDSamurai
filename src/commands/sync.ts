import * as vscode from 'vscode';
import { Config } from '../config';
import { WikiClient } from '../wiki-client';
import { sync } from '../sync-engine';

export function registerSyncCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel,
  onSyncComplete: (changes: number) => void,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.sync', async () => {
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

    // Sicherheitsabfragen für den Wiki Sync
    const firstConfirm = await vscode.window.showWarningMessage(
      'Sind Sie sich sicher, dass Sie das Wiki überschreiben wollen? Lokaler Code wird ins Wiki synchronisiert.',
      { modal: true },
      'Ja, synchronisieren',
      'Abbrechen'
    );

    if (firstConfirm !== 'Ja, synchronisieren') {
      return;
    }

    const secondConfirm = await vscode.window.showWarningMessage(
      'Sind Sie sich WIRKLICH sicher? Diese Aktion kann nicht rückgängig gemacht werden.',
      { modal: true },
      'Ja, ich bin mir absolut sicher',
      'Abbrechen'
    );

    if (secondConfirm !== 'Ja, ich bin mir absolut sicher') {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'IDSamurai Sync',
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const result = await sync(config, client, false, progress, token);

          outputChannel.clear();
          outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] IDSamurai Sync abgeschlossen`);
          outputChannel.appendLine(`  +${result.added} neu  ~${result.updated} aktualisiert  -${result.removed} gelöscht  =${result.unchanged} unverändert  ✗${result.errors} Fehler`);
          outputChannel.appendLine('');
          for (const detail of result.details) {
            outputChannel.appendLine(`  ${detail}`);
          }

          if (result.added + result.updated + result.removed === 0 && result.errors === 0) {
            vscode.window.showInformationMessage('IDSamurai: Wiki ist aktuell — 0 Änderungen.');
          } else {
            const summary = `+${result.added} ~${result.updated} -${result.removed}`;
            if (result.errors > 0) {
              vscode.window.showWarningMessage(`IDSamurai: ${summary} (${result.errors} Fehler — Details im Output Channel)`);
            } else {
              vscode.window.showInformationMessage(`IDSamurai: ${summary}`);
            }
            outputChannel.show(true);
          }

          onSyncComplete(result.added + result.updated + result.removed);
        } catch (e) {
          outputChannel.appendLine(`[FEHLER] Sync: ${e}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`IDSamurai: Sync fehlgeschlagen: ${e}`);
        }
      }
    );
  });
}
