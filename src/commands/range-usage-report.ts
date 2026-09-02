import * as vscode from 'vscode';
import { Config } from '../config';
import { parseObjectsFromConfig, parseRanges, AlObject } from '../al-parser';
import * as path from 'path';
import * as fs from 'fs';
import { WikiClient } from '../wiki-client';

export function registerRangeUsageReportCommand(
  getConfig: () => Config | null,
  getClient: () => WikiClient | null,
  outputChannel: vscode.OutputChannel
) {
  return vscode.commands.registerCommand('ids.rangeUsageReport', async () => {
    const config = getConfig();
    if (!config) {
      vscode.window.showErrorMessage('IDS: Keine Konfiguration gefunden.');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'IDS: Erstelle Range & Usage Bericht...',
        cancellable: false
      },
      async (progress) => {
        try {
          progress.report({ message: 'Lese lokale Objekte und Ranges...' });
          const objects = parseObjectsFromConfig(config);
          let appRanges = parseRanges(config);
          
          const client = getClient();
          if (client) {
            progress.report({ message: 'Lese Ranges aus dem Wiki...' });
            try {
              const mainPage = await client.readPage(config.basePath);
              const { parseWikiRanges } = require('../markdown-gen');
              const wikiRanges = parseWikiRanges(mainPage.content);
              if (wikiRanges.length > 0) {
                appRanges = JSON.parse(JSON.stringify(wikiRanges));
              }
            } catch (e) {
              // ignore, fallback to local appRanges
            }
          }
          
          let md = `# IDS: Range & Usage Bericht (Details)\n\n`;
          md += `Erstellt am: ${new Date().toLocaleString()}\n\n`;
          md += `Projekt: **${config.project}**\n\n`;
          md += `Dieser Bericht listet alle konfigurierten Ranges auf und listet detailliert, welche Objekte lokal welche ID belegen. So kann z.B. bei einem Range-Wechsel dem Innendienst genau mitgeteilt werden, welche Objekte "hinzukommen" oder "wegkommen".\n\n`;

          if (appRanges.length === 0) {
            md += `*Keine Ranges konfiguriert oder gefunden.*\n`;
          } else {
            for (const app of appRanges) {
              md += `## App: ${app.app}\n\n`;
              for (const [type, ranges] of Object.entries(app.ranges)) {
                if (ranges.length === 0) continue;
                md += `### Objekttyp: ${type}\n\n`;

                for (const range of ranges) {
                  const rangeStr = `${range.from}..${range.to}`;
                  md += `#### Range: ${rangeStr} ${range.description ? `(${range.description})` : ''}\n\n`;

                  // Finde alle Objekte in diesem Range
                  const objectsInRange = objects.filter(o => 
                    o.app === app.app && 
                    o.type.toLowerCase() === type.toLowerCase() &&
                    o.id >= range.from && o.id <= range.to
                  );

                  // Sortieren nach ID
                  objectsInRange.sort((a, b) => a.id - b.id);

                  if (objectsInRange.length === 0) {
                    md += `*(Keine Objekte in diesem Range belegt)*\n\n`;
                  } else {
                    md += `| ID | Name | Datei |\n`;
                    md += `|---|---|---|\n`;
                    for (const obj of objectsInRange) {
                      const baseName = path.basename(obj.filePath);
                      md += `| ${obj.id} | ${obj.name} | ${baseName} |\n`;
                    }
                    md += `\n**Gesamt belegt:** ${objectsInRange.length} / ${(range.to - range.from) + 1}\n\n`;
                  }
                }
              }
            }
          }

          // Speichern und Öffnen
          if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const reportPath = path.join(root, 'RangeUsageReport.md');
            fs.writeFileSync(reportPath, md, 'utf-8');
            
            const doc = await vscode.workspace.openTextDocument(reportPath);
            await vscode.window.showTextDocument(doc, { preview: false });
          }

        } catch (e: any) {
          vscode.window.showErrorMessage(`IDS: Fehler beim Erstellen des Reports: ${e.message}`);
          outputChannel.appendLine(`[Fehler] Range Usage Report: ${e}`);
        }
      }
    );
  });
}
