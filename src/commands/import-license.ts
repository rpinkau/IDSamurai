import * as vscode from 'vscode';
import * as fs from 'fs';
import { WikiClient } from '../wiki-client';
import { Config } from '../config';
import { AppRanges } from '../al-parser';
import { extractRangesSection, parseWikiRanges } from '../markdown-gen';

export function registerImportLicenseCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel,
  onComplete?: () => void
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.importLicense', async (uri?: vscode.Uri) => {
    const config = getConfig();
    const client = getClient();

    if (!config || !client) {
      vscode.window.showErrorMessage('IDSamurai: Konfiguration oder Wiki-Client fehlt.');
      return;
    }

    let content = '';

    // 1. Quelle bestimmen (Argument, Datei oder Zwischenablage)
    if (uri && uri.fsPath) {
      try {
        content = fs.readFileSync(uri.fsPath, 'utf-8');
      } catch (e: any) {
        vscode.window.showErrorMessage(`IDSamurai: Datei konnte nicht gelesen werden: ${e.message}`);
        return;
      }
    } else {
      const source = await vscode.window.showQuickPick(
        [
          '$(file) Aus Datei auswählen',
          '$(clippy) Aus Zwischenablage (Clipboard)'
        ],
        { placeHolder: 'Wie soll die Lizenz eingelesen werden?', ignoreFocusOut: true }
      );

      if (!source) {
        return;
      }

      if (source.includes('Clipboard')) {
        content = await vscode.env.clipboard.readText();
        if (!content || content.trim().length === 0) {
          vscode.window.showWarningMessage('IDSamurai: Die Zwischenablage ist leer.');
          return;
        }
      } else {
        const fileUris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Lizenz-Datei einlesen',
          filters: {
            'Textdateien': ['txt', 'flf', 'log'],
            'Alle Dateien': ['*']
          }
        });

        if (!fileUris || fileUris.length === 0) {
          return;
        }
        
        try {
          content = fs.readFileSync(fileUris[0].fsPath, 'utf-8');
        } catch (e: any) {
          vscode.window.showErrorMessage(`IDSamurai: Datei konnte nicht gelesen werden: ${e.message}`);
          return;
        }
      }
    }

    // 2. App-Name abfragen
    const appName = await vscode.window.showInputBox({
      prompt: 'Für welche App sind diese Ranges? (wird in die Tabelle eingetragen)',
      placeHolder: 'z.B. My-Base-App',
      ignoreFocusOut: true,
    });

    if (!appName) {
      return;
    }

    try {
      const lines = content.split('\n');

      const parsedRanges: { type: string, from: number, to: number }[] = [];

      // Regex für Zeilen wie "Codeunits      50000 ..     50010"
      const oldLineRegex = /([a-zA-Z\s]+?)\s+(\d+)\s*\.\.\s*(\d+)/;
      
      // Regex für BC Permissions Report: "TableData                     220            55000          55219          RIMDX"
      const bcReportRegex = /^([a-zA-Z]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+[A-Z]*$/;

      // Mapping für Lizenz-Begriffe zu AL-Typen
      const typeMapping: Record<string, string[]> = {
        'codeunit': ['codeunit', 'codeunits'],
        'table': ['table', 'tables', 'table data', 'tabledata'],
        'page': ['page', 'pages'],
        'report': ['report', 'reports'],
        'xmlport': ['xmlport', 'xmlports'],
        'query': ['query', 'queries'],
        'enum': ['enum', 'enums'],
        'tableextension': ['table extension', 'table extensions', 'tableext'],
        'pageextension': ['page extension', 'page extensions', 'pageext'],
        'reportextension': ['report extension', 'report extensions', 'reportext'],
        'enumextension': ['enum extension', 'enum extensions', 'enumext'],
        'permissionset': ['permission set', 'permission sets', 'permissionset', 'permissionsets'],
      };

      const getTypeFromLicenseString = (str: string): string | null => {
        const normalized = str.toLowerCase().trim();
        for (const [alType, aliases] of Object.entries(typeMapping)) {
          if (aliases.includes(normalized)) {
            return alType;
          }
        }
        return null;
      };

      for (const line of lines) {
        const trimmedLine = line.trim();
        let rawType: string | null = null;
        let from = 0;
        let to = 0;

        const bcMatch = bcReportRegex.exec(trimmedLine);
        const oldMatch = oldLineRegex.exec(trimmedLine);

        if (bcMatch) {
          rawType = bcMatch[1];
          from = parseInt(bcMatch[3], 10);
          to = parseInt(bcMatch[4], 10);
        } else if (oldMatch) {
          rawType = oldMatch[1];
          from = parseInt(oldMatch[2], 10);
          to = parseInt(oldMatch[3], 10);
        }

        if (rawType) {
          const alType = getTypeFromLicenseString(rawType);
          if (alType) {
            parsedRanges.push({ type: alType, from, to });
          }
        }
      }

      if (parsedRanges.length === 0) {
        vscode.window.showWarningMessage('IDSamurai: Keine gültigen Ranges (Typ + Von..Bis) in der Datei gefunden.');
        return;
      }

      outputChannel.appendLine(`[Import] Fand ${parsedRanges.length} Ranges in der Lizenzdatei.`);

      // 3. Wiki-Seite laden
      let existingContent = '';
      try {
        const page = await client.readPage(config.basePath);
        existingContent = page.content;
      } catch (e) {
        vscode.window.showErrorMessage(`IDSamurai: Konnte Wiki-Seite nicht laden: ${e}`);
        return;
      }

      // 4. Bestehende Ranges parsen, um sie mit den neuen zu mergen
      const existingAppRanges = parseWikiRanges(existingContent);
      
      // Neue Ranges in die bestehende Struktur mergen
      let targetApp = existingAppRanges.find(ar => ar.app === appName);
      if (!targetApp) {
        targetApp = { app: appName, ranges: {} };
        existingAppRanges.push(targetApp);
      }

      for (const pr of parsedRanges) {
        if (!targetApp.ranges[pr.type]) {
          targetApp.ranges[pr.type] = [];
        }
        // Vermeide exakte Duplikate
        const exists = targetApp.ranges[pr.type].some(r => r.from === pr.from && r.to === pr.to);
        if (!exists) {
          targetApp.ranges[pr.type].push({
            from: pr.from,
            to: pr.to,
            description: 'Importiert aus Lizenz'
          });
        }
      }

      // 5. Neue Markdown-Tabelle bauen
      const markdownLines: string[] = [];
      markdownLines.push('## ID-Ranges (freie Bereiche)');
      markdownLines.push('');
      markdownLines.push('> Initalbefuellung aus `.objidconfig`. Wird manuell gepflegt.');
      markdownLines.push('');
      markdownLines.push('| App | Typ | Von | Bis | Beschreibung |');
      markdownLines.push('|-----|-----|-----|-----|--------------|');

      // Alle Ranges alphabetisch nach Typ, und dann nach from ausgeben
      for (const ar of existingAppRanges) {
        const types = Object.keys(ar.ranges).sort();
        for (const type of types) {
          const sortedRanges = ar.ranges[type].sort((a, b) => a.from - b.from);
          for (const range of sortedRanges) {
            markdownLines.push(`| ${ar.app} | ${type} | ${range.from} | ${range.to} | ${range.description} |`);
          }
        }
      }
      markdownLines.push('');
      
      const newRangesSection = markdownLines.join('\n');

      // 6. Wiki-Seite updaten
      let newPageContent = existingContent;
      const oldSection = extractRangesSection(existingContent);
      
      if (oldSection) {
        // Bestehenden Abschnitt ersetzen
        newPageContent = existingContent.replace(oldSection, newRangesSection.trimEnd());
      } else {
        // Ganz oben nach der ersten # Überschrift einfügen, oder falls nicht vorhanden, ganz oben
        if (newPageContent.startsWith('# ')) {
          const lines = newPageContent.split('\n');
          let insertIndex = 1;
          // Suche das Ende der Beschreibung (alles was mit > oder leer ist nach der H1)
          while (insertIndex < lines.length && (lines[insertIndex].trim() === '' || lines[insertIndex].startsWith('>'))) {
            insertIndex++;
          }
          lines.splice(insertIndex, 0, newRangesSection, '');
          newPageContent = lines.join('\n');
        } else {
          newPageContent = newRangesSection + '\n\n' + newPageContent;
        }
      }

      // 7. Speichern
      await client.writePage(config.basePath, newPageContent);
      vscode.window.showInformationMessage('IDSamurai: Ranges erfolgreich importiert und im Wiki gespeichert!');
      
      if (onComplete) {
        onComplete();
      }

    } catch (e: any) {
      vscode.window.showErrorMessage(`IDSamurai: Fehler beim Importieren der Datei: ${e.message}`);
    }
  });
}
