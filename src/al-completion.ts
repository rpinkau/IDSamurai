import * as vscode from 'vscode';
import { Config } from './config';
import { AlObject, parseObjectsFromConfig, parseRanges, AppRanges, getAppForFile } from './al-parser';
import { getNextFreeId, getNextFreeIdWithWiki, reserveId } from './id-manager';

import { WikiClient } from './wiki-client';

// AL Objekt-Typ Keywords (alle unterstützten)
const AL_TYPE_KEYWORDS = [
  'table', 'tableextension', 'page', 'pageextension',
  'codeunit', 'report', 'enum', 'enumextension',
  'query', 'xmlport', 'permissionset', 'reportextension',
];

// Regex: "table " oder "codeunit " etc. am Zeilenanfang (mit optionaler ID 0 als Platzhalter)
const AL_OBJ_START_REGEX = new RegExp(
  `^\\s*(${AL_TYPE_KEYWORDS.join('|')})\\s+$`, 'i'
);

const FIELD_START_REGEX = /^\s*field\(/i;

async function getNextFreeFieldId(
  document: vscode.TextDocument,
  appRanges: AppRanges[],
  config: Config | null,
  client: WikiClient | null,
  outputChannel: vscode.OutputChannel,
  targetApp?: string
): Promise<number | undefined> {
  outputChannel.appendLine(`[IntelliSense] Prüfe Feld IDs...`);
  const content = document.getText();
  const objMatch = /^\s*(table|tableextension)\s+(\d+)/im.exec(content);
  if (!objMatch) return undefined;
  
  const type = objMatch[1].toLowerCase();
  const id = parseInt(objMatch[2], 10);
  
  const fieldRegex = /field\(\s*(\d+)\s*;/gi;
  const existingIds = new Set<number>();
  let match;
  while ((match = fieldRegex.exec(content)) !== null) {
    existingIds.add(parseInt(match[1], 10));
  }
  
  // Verify with wiki if client and config are available
  if (config && client) {
    const wikiPath = `${config.basePath}/${type}-${id}`;
    try {
      const wikiPage = await client.readPage(wikiPath);
      if (wikiPage) {
        // Find markdown table rows that start with a number
        const lines = wikiPage.content.split('\n');
        for (const line of lines) {
          const tableMatch = /^\|\s*(\d+)\s*\|/.exec(line);
          if (tableMatch) {
            existingIds.add(parseInt(tableMatch[1], 10));
          }
        }
      }
    } catch {
      // ignore, wiki page might not exist
    }
  }

  if (existingIds.size > 0) {
    const nextId = Math.max(...Array.from(existingIds)) + 1;
    outputChannel.appendLine(`[IntelliSense] Finde Feld ID ${nextId}...`);
    return nextId;
  }
  
  if (type === 'table') {
    outputChannel.appendLine(`[IntelliSense] Finde Feld ID 1...`);
    return 1;
  }
  
  for (const app of appRanges) {
    if (targetApp) {
      const arAppClean = app.app.replace(/\s+/g, '').toLowerCase();
      const targetAppClean = targetApp.replace(/\s+/g, '').toLowerCase();
      if (arAppClean !== targetAppClean) {
        continue;
      }
    }
    const ranges = app.ranges['tableextension'] || app.ranges['table'] || [];
    if (ranges.length > 0) {
      outputChannel.appendLine(`[IntelliSense] Finde Feld ID ${ranges[0].from}...`);
      return ranges[0].from;
    }
  }
  
  outputChannel.appendLine(`[IntelliSense] Finde Feld ID 50000...`);
  return 50000;
}

/**
 * CompletionProvider für AL-Dateien.
 * Trigger: Leerzeichen nach Typ-Keyword (z.B. "table ") ODER "field("
 * Schlägt die nächste freie ID vor.
 */
export function createAlCompletionProvider(
  getConfig: () => Config | null,
  getClient: () => WikiClient | null,
  outputChannel: vscode.OutputChannel,
  setStatusBarError: (msg: string) => void,
): vscode.CompletionItemProvider {
  return {
    async provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.CompletionItem[] | undefined> {
      const config = getConfig();
      if (!config) {
        return undefined;
      }

      const lineText = document.lineAt(position).text.substring(0, position.character);
      const isFieldMatch = FIELD_START_REGEX.test(lineText);
      const isObjectMatch = AL_OBJ_START_REGEX.exec(lineText);
      
      if (!isFieldMatch && !isObjectMatch) {
        return undefined;
      }

      let objects: AlObject[] = [];
      let appRanges: AppRanges[] = [];
      try {
        if (isObjectMatch) objects = parseObjectsFromConfig(config);
        appRanges = parseRanges(config);
      } catch {
        return undefined;
      }

      const targetApp = getAppForFile(document.uri.fsPath, config);

      if (isFieldMatch) {
        const client = getClient();
        const nextFieldId = await getNextFreeFieldId(document, appRanges, config, client, outputChannel, targetApp);
        if (!nextFieldId) {
          // Keine Warnung, da dies bei Pages oder fehlerhaften Dateien normal ist
          return undefined;
        }
        
        outputChannel.appendLine(`[IntelliSense] Schlage Feld ID ${nextFieldId} vor.`);
        const item = new vscode.CompletionItem(
          {
            label: `${nextFieldId}`,
            description: 'Samurai'
          },
          vscode.CompletionItemKind.Value
        );
        item.insertText = `${nextFieldId}`;
        item.detail = `Nächste freie Feld-ID`;
        item.documentation = new vscode.MarkdownString(`Automatisch ermittelt aus den bestehenden Feldern dieser Tabelle.`);
        item.sortText = '!00000';
        item.preselect = true;
        // Beim Bestätigen der Completion via Enter wird dieser Command getriggert, um das Logging zu erzeugen
        item.command = {
          title: 'Log field insertion',
          command: 'ids.logFieldInsertion',
          arguments: [nextFieldId]
        };
        return [item];
      }

      const objectType = isObjectMatch![1].toLowerCase();
      const client = getClient();
      let suggestion;
      try {
        if (client) {
          suggestion = await getNextFreeIdWithWiki(objectType, objects, appRanges, client, config, undefined, undefined, targetApp);
        } else {
          suggestion = getNextFreeId(objectType, objects, appRanges, targetApp);
        }
      } catch (e: any) {
        outputChannel.appendLine(`[IntelliSense] Fehler: ${e.message}`);
        setStatusBarError('Verbindung zum Wiki fehlgeschlagen');
        return undefined;
      }
      
      if (!suggestion) {
        outputChannel.appendLine(`[IntelliSense] Konnte keine freie ID für Objekttyp '${objectType}' ermitteln.`);
        if (appRanges.length === 0 || !appRanges.some(ar => Object.keys(ar.ranges).length > 0)) {
          outputChannel.appendLine(`[IntelliSense] WARNUNG: Keine ID-Ranges gefunden! Weder lokal in der app.json noch im DevOps Wiki.`);
        }
        return undefined;
      }

      outputChannel.appendLine(`[IntelliSense] Schlage Objekt-ID ${suggestion.nextFreeId} für Typ '${objectType}' vor (App: ${suggestion.app}).`);
      const item = new vscode.CompletionItem(
        {
          label: `${suggestion.nextFreeId}`,
          description: `Samurai (Range ${suggestion.range.from}..${suggestion.range.to})`
        },
        vscode.CompletionItemKind.Value,
      );
      item.insertText = `${suggestion.nextFreeId}`;
      item.detail = '';
      item.documentation = new vscode.MarkdownString(
        `**App**: ${suggestion.app}\n\n` +
        `**Range**: ${suggestion.range.from}–${suggestion.range.to}` +
        (suggestion.range.description ? ` (${suggestion.range.description})` : '') + '\n\n' +
        `**Belegt**: ${suggestion.usedCount} | **Frei**: ${suggestion.freeCount}`
      );
      item.sortText = '!00000'; // Ganz oben in der Liste
      item.preselect = true;

      return [item];
    },
  };
}

export function createAlCodeActionProvider(
  getConfig: () => Config | null,
  getClient: () => WikiClient | null,
  outputChannel: vscode.OutputChannel,
  setStatusBarError: (msg: string) => void,
): vscode.CodeActionProvider {
  return {
    async provideCodeActions(
      document: vscode.TextDocument,
      range: vscode.Range,
      context: vscode.CodeActionContext,
      token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[] | undefined> {
      const config = getConfig();
      if (!config) return undefined;

      const line = document.lineAt(range.start.line);
      const text = line.text;

      // Regex für Quick Fix Erkennung:
      const isFieldMatch = /^\s*field\(\s*(0)?\s*(?:;|\)|\s|$)/i.exec(text);
      let isObjectMatch: RegExpExecArray | null = null;
      let idPlaceholder: string | undefined = undefined;

      const objMatch = new RegExp(`^\\s*(${AL_TYPE_KEYWORDS.join('|')})\\s+(.*)`, 'i').exec(text);
      if (objMatch) {
        const afterKeyword = objMatch[2].trim();
        const firstToken = afterKeyword.split(/\s+/)[0];
        
        if (/^[1-9]\d*$/.test(firstToken)) {
          // Bereits eine gültige ID > 0 vorhanden. Nur Fix anbieten, wenn wir eine Diagnostic haben.
          const hasDiagnostic = context.diagnostics.some(d => {
            const code = (d.code && typeof d.code === 'object') ? (d.code as any).value : d.code;
            return code === 'IDS001' || code === 'IDS002' || code === 'IDS003';
          });
          if (hasDiagnostic) {
            isObjectMatch = objMatch;
            idPlaceholder = firstToken;
          } else {
            isObjectMatch = null;
          }
        } else {
          isObjectMatch = objMatch;
          if (firstToken === '0' || firstToken === '""' || firstToken === "''") {
            idPlaceholder = firstToken;
          }
        }
      }

      if (!isFieldMatch && !isObjectMatch) {
        return undefined;
      }

      let objects: AlObject[] = [];
      let appRanges: AppRanges[] = [];
      try {
        if (isObjectMatch) objects = parseObjectsFromConfig(config);
        appRanges = parseRanges(config);
      } catch {
        return undefined;
      }

      let newId: number | undefined;
      let replaceRange: vscode.Range | undefined;
      const targetApp = getAppForFile(document.uri.fsPath, config);
      
      if (isFieldMatch) {
        const client = getClient();
        const nextFieldId = await getNextFreeFieldId(document, appRanges, config, client, outputChannel, targetApp);
        if (!nextFieldId) {
          outputChannel.appendLine(`[QuickFix] Konnte keine freie Feld-ID ermitteln.`);
          return undefined;
        }
        newId = nextFieldId;

        const matchStr = isFieldMatch[0];
        const matchIndex = text.indexOf(matchStr);
        if (isFieldMatch[1] === '0') {
           const zeroIndex = text.indexOf('0', matchIndex + 5);
           replaceRange = new vscode.Range(range.start.line, zeroIndex, range.start.line, zeroIndex + 1);
        } else {
           const parenIndex = text.indexOf('(', matchIndex) + 1;
           replaceRange = new vscode.Range(range.start.line, parenIndex, range.start.line, parenIndex);
        }
      } else if (isObjectMatch) {
        const objectType = isObjectMatch[1].toLowerCase();
        const client = getClient();
        let suggestion;
        try {
          if (client) {
            suggestion = await getNextFreeIdWithWiki(objectType, objects, appRanges, client, config, undefined, undefined, targetApp);
          } else {
            suggestion = getNextFreeId(objectType, objects, appRanges, targetApp);
          }
        } catch (e: any) {
          outputChannel.appendLine(`[QuickFix] Fehler: ${e.message}`);
          setStatusBarError('Verbindung zum Wiki fehlgeschlagen');
          return undefined;
        }

        if (!suggestion) {
          const msg = `Samurai: Konnte keine freie ID für '${objectType}' ermitteln. Bitte überprüfe die Tabelle "ID-Ranges (freie Bereiche)" auf der Wiki-Seite!`;
          outputChannel.appendLine(`[QuickFix] ${msg}`);
          vscode.window.showErrorMessage(msg);
          return undefined;
        }
        newId = suggestion.nextFreeId;

        // Verwende den originalen Text für das indexOf, um gemischte Groß-/Kleinschreibung zu unterstützen (M5)
        const matchIndex = text.indexOf(isObjectMatch[1]) + isObjectMatch[1].length;
        if (idPlaceholder) {
           const idTokenIndex = text.indexOf(idPlaceholder, matchIndex);
           replaceRange = new vscode.Range(range.start.line, idTokenIndex, range.start.line, idTokenIndex + idPlaceholder.length);
        } else {
           const afterTypeIndex = text.indexOf(isObjectMatch[1]) + isObjectMatch[1].length;
           replaceRange = new vscode.Range(range.start.line, afterTypeIndex, range.start.line, afterTypeIndex);
        }
      }

      if (newId === undefined || !replaceRange) return undefined;

      let replacementStr = newId.toString();
      if (isObjectMatch && !idPlaceholder) {
        replacementStr = ` ${newId}`;
      }

      if (isFieldMatch) {
        // Für Felder den Insert-Command aufrufen
        const action = new vscode.CodeAction(`Samurai: Nächste freie Feld-ID eintragen (${newId})`, vscode.CodeActionKind.QuickFix);
        action.command = {
          command: 'ids.insertFieldId',
          title: 'Feld-ID eintragen',
          arguments: [document, replaceRange, replacementStr, newId]
        };
        action.isPreferred = true;
        return [action];
      } else {
        const diagnostics = context.diagnostics;
        let fixKind = 'Nächste freie ID eintragen';
        if (diagnostics.some(d => {
          const code = (d.code && typeof d.code === 'object') ? (d.code as any).value : d.code;
          return code === 'IDS002' || code === 'IDS003';
        })) {
          fixKind = 'Kollision beheben (Nächste freie ID ziehen)';
        }

        const title = isObjectMatch && idPlaceholder !== '0' && idPlaceholder !== '""' && idPlaceholder !== "''" 
          ? `IDS: ${fixKind}` 
          : 'IDS: ID im Wiki reservieren und eintragen';

        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.command = {
          command: 'ids.reserveAndInsertId',
          title: 'ID reservieren',
          arguments: [document, replaceRange, replacementStr, isObjectMatch![1].toLowerCase()]
        };
        const relatedDiagnostic = context.diagnostics.find(d => {
          const code = (d.code && typeof d.code === 'object') ? (d.code as any).value : d.code;
          return code === 'IDS001' || code === 'IDS002' || code === 'IDS003';
        });
        if (relatedDiagnostic) {
          action.diagnostics = [relatedDiagnostic];
        }
        action.isPreferred = true;
        return [action];
      }
    }
  };
}

export function registerReserveAndInsertIdCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.reserveAndInsertId', async (document: vscode.TextDocument, replaceRange: vscode.Range, replacementStr: string, objectType: string) => {
    const config = getConfig();
    const client = getClient();
    
    if (!config || !client) {
      vscode.window.showErrorMessage('IDSamurai: Konfiguration oder PAT fehlt für Reservierung.');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Reserviere ${objectType} ID im Wiki...`,
        cancellable: false,
      },
      async () => {
        try {
          const objects = parseObjectsFromConfig(config);
          const appRanges = parseRanges(config);
          const targetApp = getAppForFile(document.uri.fsPath, config);
          
          const suggestion = await reserveId(objectType, objects, appRanges, client, config, undefined, undefined, undefined, targetApp);
          
          if (!suggestion) {
            vscode.window.showErrorMessage(`IDSamurai: Alle Ranges für "${objectType}" sind voll!`);
            return;
          }

          const editor = vscode.window.activeTextEditor;
          if (editor && editor.document === document) {
            // Wir verwenden die neu reservierte ID, falls sie abweicht (Race Condition gelöst)
            const actualReplacementStr = replacementStr.replace(/\d+/, suggestion.nextFreeId.toString());
            await editor.edit(editBuilder => {
              editBuilder.replace(replaceRange, actualReplacementStr);
            });
            vscode.window.showInformationMessage(`IDSamurai: ID ${suggestion.nextFreeId} erfolgreich reserviert und eingefügt.`);
          }
        } catch (e) {
          outputChannel.appendLine(`[FEHLER] Fehler bei ID-Reservierung: ${e}`);
          vscode.window.showErrorMessage(`IDSamurai: Konnte ID nicht reservieren.`);
        }
      }
    );
  });
}

export function registerFieldIdCommands(outputChannel: vscode.OutputChannel): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('ids.logFieldInsertion', async (id: number) => {
      outputChannel.appendLine(`[IntelliSense] Reserviere Feld ID ${id}`);
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await editor.document.save();
      }
    }),
    vscode.commands.registerCommand('ids.insertFieldId', async (document: vscode.TextDocument, replaceRange: vscode.Range, replacementStr: string, id: number) => {
      outputChannel.appendLine(`[QuickFix] Reserviere Feld ID ${id}`);
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === document) {
        await editor.edit(editBuilder => {
          editBuilder.replace(replaceRange, replacementStr);
        });
        await document.save();
      }
    })
  ];
}
