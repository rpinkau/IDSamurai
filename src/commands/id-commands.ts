import * as vscode from 'vscode';
import * as path from 'path';
import { Config } from '../config';
import { parseObjectsFromConfig, parseRanges } from '../al-parser';
import {
  getNextFreeId,
  reserveId,
  getRangeStats,
  getTypesWithRanges,
  formatRangeStats,
} from '../id-manager';
import { WikiClient } from '../wiki-client';
import { WikiTreeItem } from '../views/wiki-tree';

export function registerNextIdCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.nextId', async () => {
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

    const objects = parseObjectsFromConfig(config);
    const appRanges = parseRanges(config);
    const types = getTypesWithRanges(appRanges);

    if (types.length === 0) {
      vscode.window.showWarningMessage('IDSamurai: Keine ID-Ranges in .objidconfig oder app.json gefunden.');
      return;
    }

    // Typ auswählen
    const selected = await vscode.window.showQuickPick(
      types.map(t => ({ label: t, description: getTypeSummary(t, objects, appRanges) })),
      { placeHolder: 'Objekttyp wählen…' }
    );

    if (!selected) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Reserviere ${selected.label} ID im Wiki...`,
        cancellable: false,
      },
      async () => {
        try {
          const suggestion = await reserveId(selected.label, objects, appRanges, client, config);
          if (!suggestion) {
            vscode.window.showWarningMessage(`IDSamurai: Alle Ranges für "${selected.label}" sind voll!`);
            return;
          }

          const idStr = String(suggestion.nextFreeId);

          // In Clipboard kopieren
          await vscode.env.clipboard.writeText(idStr);

          // Wenn aktiver Editor eine AL-Datei ist: ID an Cursor-Position einfügen
          const editor = vscode.window.activeTextEditor;
          if (editor && path.extname(editor.document.fileName) === '.al') {
            await editor.edit(editBuilder => {
              editBuilder.insert(editor.selection.active, idStr);
            });
          }

          vscode.window.showInformationMessage(
            `Nächste freie ${selected.label}-ID reserviert: ${suggestion.nextFreeId} ` +
            `(Range ${suggestion.range.from}-${suggestion.range.to}) â€” in Clipboard kopiert.`
          );
        } catch (e) {
          outputChannel.appendLine(`[FEHLER] Fehler bei ID-Reservierung: ${e}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`IDSamurai: Konnte ID nicht reservieren. Details im Output Channel.`);
        }
      }
    );
  });
}

export function registerShowRangesCommand(
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.showRanges', async () => {
    const config = getConfig();
    if (!config) {
      vscode.window.showWarningMessage('IDSamurai: Keine .devops-wiki.json gefunden.', 'Erstellen').then(selection => {
        if (selection === 'Erstellen') {
          vscode.commands.executeCommand('ids.createConfigTemplate');
        }
      });
      return;
    }

    const objects = parseObjectsFromConfig(config);
    const appRanges = parseRanges(config);
    const stats = getRangeStats(objects, appRanges);

    if (stats.length === 0) {
      vscode.window.showWarningMessage('IDSamurai: Keine ID-Ranges gefunden.');
      return;
    }

    const lines = formatRangeStats(stats);
    outputChannel.clear();
    for (const line of lines) {
      outputChannel.appendLine(line);
    }
    outputChannel.show();
  });
}

export function registerReclaimIdCommand(
  getClient: () => WikiClient | null,
  outputChannel: vscode.OutputChannel,
  refreshTree: () => void
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.reclaimId', async (item: WikiTreeItem) => {
    if (item.filePath) {
      vscode.window.showInformationMessage(`Das Objekt ${item.label} existiert lokal. Um die ID im Wiki freizugeben, lösche bitte die Datei im Explorer. IDSamurai gibt die ID dann automatisch per Smart Cleanup frei.`);
      return;
    }

    if (!item.wikiPath) {
      vscode.window.showInformationMessage(`Das Objekt ${item.label} ist ein manueller Eintrag auf der Hauptseite. Dieser kann derzeit nicht automatisch gelöscht werden.`);
      return;
    }

    const client = getClient();
    if (!client) {
      vscode.window.showWarningMessage('IDSamurai: Kein PAT konfiguriert.');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Soll die reservierte ID '${item.label}' wirklich wieder freigegeben (aus dem Wiki gelöscht) werden?`,
      { modal: true },
      'Ja, freigeben'
    );

    if (confirm !== 'Ja, freigeben') {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Gebe ID frei...`,
        cancellable: false,
      },
      async () => {
        try {
          await client.deletePage(item.wikiPath!);
          outputChannel.appendLine(`[Wiki] Seite gelöscht: ${item.wikiPath}`);
          refreshTree();
          vscode.window.showInformationMessage(`Die ID wurde erfolgreich freigegeben.`);
        } catch (e: any) {
          outputChannel.appendLine(`[FEHLER] Fehler beim Freigeben der ID: ${e.message}`);
          vscode.window.showErrorMessage(`ID konnte nicht freigegeben werden. (Siehe Output)`);
        }
      }
    );
  });
}

function getTypeSummary(
  type: string,
  objects: ReturnType<typeof parseObjectsFromConfig>,
  appRanges: ReturnType<typeof parseRanges>,
): string {
  const suggestion = getNextFreeId(type, objects, appRanges);
  if (!suggestion) {
    return 'Range voll!';
  }
  return `Nächste ID: ${suggestion.nextFreeId} (${suggestion.freeCount} frei)`;
}

export function registerBulkReserveCommand(
  getConfig: () => Config | null,
  getClient: () => WikiClient | null,
  outputChannel: vscode.OutputChannel,
  refreshTree: () => void
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.bulkReserve', async () => {
    const config = getConfig();
    const client = getClient();
    if (!config || !client) {
      vscode.window.showErrorMessage('IDSamurai: Konfiguration oder PAT fehlt für Bulk-Reservierung.');
      return;
    }

    const LICENSED_TYPES = ['table', 'page', 'codeunit', 'report', 'xmlport', 'query', 'enum'];
    
    // Schritt 1: Objekttyp auswählen
    const selectedType = await vscode.window.showQuickPick(LICENSED_TYPES, {
      title: 'Bulk-Reservierung: Wähle den Objekttyp',
      placeHolder: 'z.B. page'
    });
    
    if (!selectedType) return;

    // Schritt 2: Anzahl eingeben
    const amountStr = await vscode.window.showInputBox({
      title: `Wie viele IDs für '${selectedType}' möchtest du reservieren?`,
      prompt: 'Bitte eine Zahl zwischen 1 und 20 eingeben',
      validateInput: text => {
        const num = parseInt(text, 10);
        if (isNaN(num) || num <= 0) return 'Bitte eine gültige Zahl größer 0 eingeben';
        if (num > 20) return 'Bulk-Reservierungen von mehr als 20 Objekten sind nicht zulässig.';
        return null;
      }
    });

    if (!amountStr) return;
    const amount = parseInt(amountStr, 10);
    
    // Schritt 2.5: Rückfrage (Bestätigung)
    const confirmation = await vscode.window.showWarningMessage(
      `Möchtest du wirklich ${amount} neue IDs für '${selectedType}' im Wiki reservieren?`,
      { modal: true },
      'Ja, reservieren'
    );
    if (confirmation !== 'Ja, reservieren') return;

    // Schritt 3: Ausführung
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Reserviere ${amount} IDs für '${selectedType}' im Wiki...`,
        cancellable: false,
      },
      async (progress) => {
        try {
          const objects = parseObjectsFromConfig(config);
          const appRanges = parseRanges(config);
          const reservedIds: number[] = [];

          // Fetch Wiki State ONCE for bulk reservation (H4)
          progress.report({ message: `Lade Wiki-Status...`, increment: 10 });
          const cachedWikiSubPages: any[] = await client.listSubPages(config.basePath).catch(() => []);
          const cachedMainPage = await client.readPage(config.basePath).catch(() => ({ content: '' }));
          const cachedMainPageContent = cachedMainPage.content;

          for (let i = 0; i < amount; i++) {
            progress.report({ message: `Reserviere ID ${i + 1} von ${amount}...`, increment: (90 / amount) });
            const suggestion = await reserveId(selectedType, objects, appRanges, client, config, cachedWikiSubPages, cachedMainPageContent);
            if (!suggestion) {
              vscode.window.showErrorMessage(`Bulk-Reservierung abgebrochen: Ranges für "${selectedType}" sind voll nach ${i} Reservierungen!`);
              break;
            }
            reservedIds.push(suggestion.nextFreeId);
            // Cache für die nächste Iteration in der Schleife aktualisieren, sonst wird dieselbe ID vergeben
            objects.push({ app: suggestion.app, type: selectedType, id: suggestion.nextFreeId, name: 'Bulk Reserved', filePath: '' });
            cachedWikiSubPages.push({ path: `${config.basePath}/${selectedType}-${suggestion.nextFreeId}`, url: '' });
          }

          if (reservedIds.length > 0) {
            const resultText = reservedIds.join(', ');
            await vscode.env.clipboard.writeText(resultText);
            vscode.window.showInformationMessage(`Erfolgreich ${reservedIds.length} IDs reserviert: ${resultText} (in Zwischenablage kopiert)`);
            outputChannel.appendLine(`[Bulk] Reserviert: ${selectedType} IDs: ${resultText}`);
            refreshTree();
          }

        } catch (e: any) {
          outputChannel.appendLine(`[FEHLER] Bulk-Reservierung fehlgeschlagen: ${e.message}`);
          vscode.window.showErrorMessage(`Fehler bei Bulk-Reservierung. (Siehe Output)`);
        }
      }
    );
  });
}

export function registerResolveConflictLocalCommand(
  refreshTree: () => void
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.resolveConflictLocal', async (item: WikiTreeItem) => {
    if (!item.filePath) return;
    
    const confirm = await vscode.window.showInformationMessage(
      `Soll der Name von '${item.label}' in das Wiki übernommen werden? (Dies löst den Konflikt, indem das Wiki aktualisiert wird)`,
      { modal: true },
      'Ja, übernehmen'
    );
    if (confirm !== 'Ja, übernehmen') return;
    
    // Trigger sync
    vscode.commands.executeCommand('ids.sync');
  });
}

export function registerResolveConflictWikiCommand(
  refreshTree: () => void
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.resolveConflictWiki', async (item: WikiTreeItem) => {
    if (!item.filePath) return;
    
    const confirm = await vscode.window.showWarningMessage(
      `Soll für dein lokales Objekt eine NEUE ID vergeben werden? (Dies löst den Konflikt, indem das Wiki die aktuelle ID behält)`,
      { modal: true },
      'Ja, neue ID vergeben'
    );
    if (confirm !== 'Ja, neue ID vergeben') return;
    
    // Trigger refactorId for this specific file
    vscode.commands.executeCommand('ids.refactorId', vscode.Uri.file(item.filePath));
  });
}
