import * as vscode from 'vscode';
import { Config } from '../config';
import { WikiClient } from '../wiki-client';
import { parseObjectsFromConfig, parseRanges } from '../al-parser';
import { getRangeStatsWithWiki, getRangeStats } from '../id-manager';

export function registerConsumptionReportCommand(
  getConfig: () => Config | null,
  getClient: () => WikiClient | null,
  outputChannel: vscode.OutputChannel
) {
  return vscode.commands.registerCommand('ids.consumptionReport', async () => {
    const config = getConfig();
    if (!config) {
      vscode.window.showErrorMessage('IDS: Keine Konfiguration gefunden.');
      return;
    }

    const client = getClient();
    
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'IDS: Erstelle Consumption Report...',
        cancellable: false
      },
      async (progress) => {
        try {
          // Parse lokaler Code
          progress.report({ message: 'Lese lokale Objekte...' });
          const objects = parseObjectsFromConfig(config);
          const appRanges = parseRanges(config);
          
          let stats = [];
          if (client) {
            progress.report({ message: 'Gleiche mit Wiki ab...' });
            stats = await getRangeStatsWithWiki(objects, appRanges, client, config, outputChannel);
          } else {
            stats = getRangeStats(objects, appRanges);
          }

          // Generate Markdown
          let md = `# IDS: Consumption Report\n\n`;
          md += `Erstellt am: ${new Date().toLocaleString()}\n\n`;
          md += `Projekt: **${config.project}**\n\n`;
          
          if (stats.length === 0) {
            md += `*Keine Ranges konfiguriert oder gefunden.*\n`;
          } else {
            // Group by App
            const byApp = new Map<string, typeof stats>();
            for (const s of stats) {
              if (!byApp.has(s.app)) byApp.set(s.app, []);
              byApp.get(s.app)!.push(s);
            }

            for (const [app, appStats] of byApp.entries()) {
              md += `## App: ${app}\n\n`;
              md += `| Typ | Range | Belegt | Frei | Gesamt | Auslastung |\n`;
              md += `|-----|-------|--------|------|--------|------------|\n`;
              
              appStats.sort((a, b) => a.type.localeCompare(b.type));
              
              for (const s of appStats) {
                const total = s.range.to - s.range.from + 1;
                const percent = Math.round((s.usedCount / total) * 100);
                
                // Visual bar
                const barLength = 20;
                const filled = Math.round((percent / 100) * barLength);
                const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
                
                let warning = '';
                if (percent >= 90) warning = ' ⚠️';
                else if (percent >= 75) warning = ' 🟠';
                
                md += `| ${s.type} | ${s.range.from}..${s.range.to} | ${s.usedCount} | ${s.freeCount} | ${total} | \`${bar}\` ${percent}%${warning} |\n`;
              }
              md += `\n`;
            }
          }
          
          // Open as Untitled Markdown file
          const doc = await vscode.workspace.openTextDocument({
            content: md,
            language: 'markdown'
          });
          await vscode.window.showTextDocument(doc, { preview: false });

        } catch (e: any) {
          vscode.window.showErrorMessage('Fehler beim Erstellen des Reports: ' + e.message);
        }
      }
    );
  });
}
