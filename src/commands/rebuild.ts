import * as vscode from 'vscode';
import { Config } from '../config';
import { WikiClient } from '../wiki-client';
import { rebuild } from '../sync-engine';

export function registerRebuildCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel,
  onSyncComplete: (changes: number) => void,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.rebuild', async () => {
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

    // Bestätigung erforderlich — destruktive Operation
    const answer = await vscode.window.showWarningMessage(
      'IDSamurai: Rebuild überschreibt ALLE Wiki-Seiten aus dem Quellcode. Fortfahren?',
      { modal: true },
      'Ja, Rebuild starten',
    );

    if (answer !== 'Ja, Rebuild starten') {
      return;
    }

    const answer2 = await vscode.window.showInformationMessage(
      'IDSamurai: Sollen auch alte, verwaiste Objekt-Seiten (z. B. ohne Unterordner) im gesamten Wiki gesucht und gelöscht werden?',
      { modal: true },
      'Ja, nach verwaisten Seiten suchen',
      'Nein, nur aktuellen Ordner aufräumen'
    );
    const cleanupOrphaned = answer2 === 'Ja, nach verwaisten Seiten suchen';

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'IDSamurai Rebuild',
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const result = await rebuild(config, client, progress, token, cleanupOrphaned);

          outputChannel.clear();
          outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] IDSamurai Rebuild abgeschlossen`);
          outputChannel.appendLine(`  ${result.updated} Seiten geschrieben  ✗${result.errors} Fehler`);
          outputChannel.appendLine('');
          for (const detail of result.details) {
            outputChannel.appendLine(`  ${detail}`);
          }

          if (result.errors > 0) {
            vscode.window.showWarningMessage(
              `IDSamurai Rebuild: ${result.updated} Seiten. ${result.errors} Fehler — Details im Output Channel.`
            );
          } else {
            vscode.window.showInformationMessage(
              `IDSamurai Rebuild: Fertig. ${result.updated} Seiten generiert.`
            );
          }
          outputChannel.show(true);
          onSyncComplete(result.updated);
        } catch (e) {
          outputChannel.appendLine(`[FEHLER] Rebuild: ${e}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`IDSamurai Rebuild: Fehlgeschlagen: ${e}`);
        }
      }
    );
  });
}
