import * as vscode from 'vscode';
import { Config } from './config';
import { WikiClient, WikiPageRef } from './wiki-client';
import { AlObject, parseObjectsFromConfig } from './al-parser';
import { parseSubPageName } from './markdown-gen';

export function createAlHoverProvider(
  getConfig: () => Config | null,
  getClient: () => WikiClient | null,
  outputChannel: vscode.OutputChannel,
): vscode.HoverProvider {
  let cachedWikiPages: WikiPageRef[] = [];
  let lastWikiCacheUpdate = 0;
  let isFetchingWikiPages = false;
  let wikiPagesPromise: Promise<WikiPageRef[]> | null = null;
  const cachedWikiNames = new Map<string, string>();

  return {
    async provideHover(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
      const config = getConfig();
      const client = getClient();
      if (!config || !client) return undefined;

      const range = document.getWordRangeAtPosition(position);
      if (!range) return undefined;

      const lineText = document.lineAt(position.line).text;
      
      // Check if it's an AL Object definition
      const objMatch = /^\s*(table|page|codeunit|report|xmlport|query|enum|tableextension|pageextension|reportextension|enumextension)\s+(\d+)\s+("?[a-zA-Z0-9_\s\-]+"?[ \t]*)/i.exec(lineText);
      if (objMatch) {
        const typeStr = objMatch[1].toLowerCase();
        const id = parseInt(objMatch[2], 10);
        const name = objMatch[3].trim().replace(/^"|"$/g, '');

        // Make sure we are hovering over the ID
        const idIndex = lineText.indexOf(objMatch[2], objMatch[1].length);
        if (position.character >= idIndex && position.character <= idIndex + objMatch[2].length) {
          
          const now = Date.now();
          if (now - lastWikiCacheUpdate > 120 * 1000) {
            if (!isFetchingWikiPages) {
              isFetchingWikiPages = true;
              wikiPagesPromise = client.listSubPages(config.basePath).then(pages => {
                cachedWikiPages = pages;
                lastWikiCacheUpdate = Date.now();
                isFetchingWikiPages = false;
                wikiPagesPromise = null;
                return pages;
              }).catch(e => {
                isFetchingWikiPages = false;
                wikiPagesPromise = null;
                return cachedWikiPages;
              });
            }
            if (wikiPagesPromise) {
              await wikiPagesPromise;
            }
          }

          let isConflict = false;
          let isMissing = false;
          let wikiName: string | undefined;

          const wikiPath = `${config.basePath}/${typeStr}-${id}`;
          
          try {
            // Aus Cache laden, falls vorhanden
            let nameFromCache = cachedWikiNames.get(wikiPath);
            
            if (nameFromCache === undefined) {
              const _globalThis: any = globalThis;
              if (!_globalThis.hoverWikiNamePromises) {
                _globalThis.hoverWikiNamePromises = new Map();
              }
              let namePromise = _globalThis.hoverWikiNamePromises.get(wikiPath);
              if (!namePromise) {
                namePromise = client.readPage(wikiPath).then(wikiPage => {
                  let parsedName = '';
                  if (wikiPage) {
                    const match = /^#\s*(.*)/m.exec(wikiPage.content);
                    if (match) {
                      parsedName = match[1].trim();
                    }
                  }
                  cachedWikiNames.set(wikiPath, parsedName);
                  return parsedName;
                }).catch(() => {
                  // NotFound or other error
                  cachedWikiNames.set(wikiPath, '__MISSING__');
                  return '__MISSING__';
                }).finally(() => {
                  _globalThis.hoverWikiNamePromises.delete(wikiPath);
                });
                _globalThis.hoverWikiNamePromises.set(wikiPath, namePromise);
              }
              nameFromCache = await namePromise;
            }

            if (nameFromCache === '__MISSING__') {
              isMissing = true;
            } else if (nameFromCache && nameFromCache !== 'Reservation') {
              wikiName = nameFromCache;
              const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (simplify(name) !== simplify(wikiName)) {
                isConflict = true;
              }
            }
          } catch {
            isMissing = true;
          }

          const hoverContent = new vscode.MarkdownString();
          hoverContent.isTrusted = true; // WICHTIG für Commands

          if (isConflict) {
            hoverContent.appendMarkdown(`**ID Samurai:** 🔴 **Harter Konflikt!**\n\n`);
            hoverContent.appendMarkdown(`Lokal heißt das Objekt \`${name}\`.\n`);
            hoverContent.appendMarkdown(`Im Wiki ist die ID von \`${wikiName}\` belegt.\n\n`);
            hoverContent.appendMarkdown(`**Aktionen:**\n`);
            // Wir nutzen commands, die schon registriert sind
            const resolveWikiCmd = vscode.Uri.parse(`command:ids.resolveConflictWiki`);
            const resolveLocalCmd = vscode.Uri.parse(`command:ids.resolveConflictLocal`);
            
            hoverContent.appendMarkdown(`- [Wiki gewinnt (Neue ID ziehen)](${resolveWikiCmd} "Neue ID vergeben")\n`);
            hoverContent.appendMarkdown(`- [Lokal gewinnt (Name ins Wiki übernehmen)](${resolveLocalCmd} "Deinen Namen ins Wiki zwingen")\n`);
          } else if (isMissing) {
            hoverContent.appendMarkdown(`**ID Samurai:** 🟠 **Nicht registriert!**\n\n`);
            hoverContent.appendMarkdown(`Die ID \`${id}\` existiert lokal, ist aber **nicht im Wiki** reserviert.\n\n`);
            hoverContent.appendMarkdown(`**Aktionen:**\n`);
            const reserveCmd = vscode.Uri.parse(`command:ids.bulkReserve`);
            hoverContent.appendMarkdown(`- [ID im Wiki registrieren](${reserveCmd} "IDs synchronisieren")\n`);
          } else {
            hoverContent.appendMarkdown(`**ID Samurai:** ✅ **Registriert!**\n\n`);
            hoverContent.appendMarkdown(`Die ID \`${id}\` ist korrekt im Wiki reserviert.\n`);
          }

          return new vscode.Hover(hoverContent);
        }
      }

      // Check if it's a Field definition
      const fieldMatch = /^\s*field\(\s*(\d+)\s*;/i.exec(lineText);
      if (fieldMatch) {
        const fieldId = parseInt(fieldMatch[1], 10);
        const idIndex = lineText.indexOf(fieldMatch[1], lineText.indexOf('field(') + 5);
        
        if (position.character >= idIndex && position.character <= idIndex + fieldMatch[1].length) {
          
          const hoverContent = new vscode.MarkdownString();
          hoverContent.isTrusted = true;
          hoverContent.appendMarkdown(`**ID Samurai:** Feld-ID \`${fieldId}\`\n\n`);
          hoverContent.appendMarkdown(`Um eine neue, freie ID für dieses Feld zu erhalten:\n\n`);
          
          // Code actions for field ids
          // Wait, field ID checking against wiki is too complex for this sync hover. We just offer to pull next id.
          // But we can check if it's 0.
          if (fieldId === 0) {
             hoverContent.appendMarkdown(`🔴 ID ist 0.\n\n`);
             // Quick Fix command for next field id doesn't exist globally without args, but we can just tell them to use the lightbulb.
             hoverContent.appendMarkdown(`Nutze die Glühbirne (Quick Fix / Alt+Enter), um die nächste freie ID einzutragen.\n`);
          } else {
             hoverContent.appendMarkdown(`Nutze die Glühbirne (Quick Fix / Alt+Enter) falls du eine neue Nummer brauchst.\n`);
          }

          return new vscode.Hover(hoverContent);
        }
      }

      return undefined;
    }
  };
}
