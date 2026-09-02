import * as vscode from 'vscode';
import { Config, buildPageUrl } from '../config';
import { WikiClient } from '../wiki-client';

export function registerOpenPageCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.openPage', async () => {
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

    // Sub-Pages laden für Quick-Pick
    let subPages: { label: string; url: string }[] = [];
    try {
      const pages = await client.listSubPages(config.basePath);
      subPages = pages.map(p => ({
        label: p.path.split('/').pop() ?? p.path,
        url: buildPageUrl(config, p.path),
      }));
    } catch {
      // Fallback: nur Hauptseite anbieten
    }

    // Hauptseite vorne
    const items = [
      {
        label: '$(home) Hauptseite (Objekt-IDs)',
        url: buildPageUrl(config, config.basePath),
      },
      ...subPages.map(p => ({ label: `$(file) ${p.label}`, url: p.url })),
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Wiki-Seite auswählen…',
      matchOnDescription: true,
    });

    if (selected) {
      await vscode.env.openExternal(vscode.Uri.parse(selected.url));
    }
  });
}
