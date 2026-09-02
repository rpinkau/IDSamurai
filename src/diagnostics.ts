import * as vscode from 'vscode';
import { Config } from './config';
import { AppRanges } from './al-parser';
import { WikiClient, WikiPageRef } from './wiki-client';
import { parseSubPageName } from './markdown-gen';

export const idDiagnosticCollection = vscode.languages.createDiagnosticCollection('idSamurai');

let cachedWikiPages: WikiPageRef[] = [];
let cachedWikiNames = new Map<string, string>();
let cachedWikiRanges: AppRanges[] | null = null;
let lastWikiCacheUpdate = 0;
let isFetchingWikiPages = false;
let wikiPagesPromise: Promise<WikiPageRef[]> | null = null;

export async function refreshDiagnostics(
  document: vscode.TextDocument,
  config: Config | null,
  client: WikiClient | null
) {
  if (!config || !client) {
    idDiagnosticCollection.delete(document.uri);
    return;
  }

  // Only check AL files
  if (document.languageId !== 'al') {
    return;
  }

  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];

  let localObjs: any[] | null = null;
  let localAppRanges: any[] | null = null;
  let rangeStats: any[] | null = null;

  // Match object declarations e.g. "table 50000 MyTable"
  const objRegex = /^[ \t]*([a-zA-Z]+)[ \t]+(\d+)[ \t]+("?[a-zA-Z0-9_\s\-]+"?[ \t]*)(?:extends[ \t]+("?[a-zA-Z0-9_\s\-]+"?)?)?[ \t]*\{/gm;
  
  let match;
  while ((match = objRegex.exec(text)) !== null) {
    const typeStr = match[1].toLowerCase();
    const id = parseInt(match[2], 10);
    const name = match[3].trim().replace(/^"|"$/g, '');

    // Skip page extensions, table extensions etc if they don't need licenses/ranges
    const LICENSED_TYPES = ['table', 'page', 'codeunit', 'report', 'xmlport', 'query', 'enum'];
    if (!LICENSED_TYPES.includes(typeStr)) {
      continue;
    }

    const startPos = document.positionAt(match.index);
    // Find where the ID starts (start searching after the type string to avoid false matches)
    const idIndex = match[0].indexOf(match[2], match[1].length);
    const idStartPos = document.positionAt(match.index + idIndex);
    const idEndPos = document.positionAt(match.index + idIndex + match[2].length);
    const range = new vscode.Range(idStartPos, idEndPos);

    // 1. Check Range
    let inRange = false;
    let matchingRange: any = null;
    let appRanges: AppRanges[] = [];
    try {
      const { parseRanges } = require('./al-parser');
      appRanges = parseRanges(config);
      
      // Override with Wiki-defined ranges if available (M4)
      if (cachedWikiRanges && cachedWikiRanges.length > 0) {
        appRanges = JSON.parse(JSON.stringify(cachedWikiRanges));
      }
      
      for (const ar of appRanges) {
        const typeRanges = ar.ranges[typeStr];
        if (typeRanges) {
          for (const r of typeRanges) {
            if (id >= r.from && id <= r.to) {
              inRange = true;
              matchingRange = r;
              break;
            }
          }
        }
        if (inRange) break;
      }
    } catch (e) {
      console.error(e);
    }

    if (!inRange && appRanges.length > 0) {
      const diag = new vscode.Diagnostic(
        range,
        `IDSamurai: Die ID ${id} liegt außerhalb der lizenzierten ${typeStr} Ranges!`,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = 'IDSamurai';
      diag.code = { value: 'IDS001', target: vscode.Uri.parse('https://github.com/rpinkau/IDSamurai#ids001') };
      diagnostics.push(diag);
    } else if (inRange && matchingRange) {
      try {
        const { getRangeStats } = require('./id-manager');
        const { parseObjectsFromConfig } = require('./al-parser');
        
        if (!localObjs) {
          localObjs = parseObjectsFromConfig(config);
          localAppRanges = appRanges;
          rangeStats = getRangeStats(localObjs, localAppRanges);
        }
        
        const rStat = rangeStats!.find((s: any) => s.type === typeStr && s.range.from === matchingRange.from && s.range.to === matchingRange.to);
        if (rStat) {
          const total = rStat.range.to - rStat.range.from + 1;
          const percentFree = rStat.freeCount / total;
          if (percentFree <= 0.1 && rStat.freeCount > 0) {
            const diag = new vscode.Diagnostic(
              range,
              `Range fast voll: Nur noch ${rStat.freeCount} von ${total} IDs frei in [${rStat.range.from}..${rStat.range.to}].`,
              vscode.DiagnosticSeverity.Warning
            );
            diag.source = 'IDSamurai';
            diag.code = { value: 'IDS004', target: vscode.Uri.parse('https://github.com/rpinkau/IDSamurai#ids004') };
            diagnostics.push(diag);
          }
        }
      } catch (e) {}
    }

    // 2. Check Wiki Collision
    // We update cache every 2 minutes or so if client is available
    const now = Date.now();
    if (now - lastWikiCacheUpdate > 120 * 1000) {
      try {
        cachedWikiPages = await client.listSubPages(config.basePath);
        
        // Fetch main page to extract wiki ranges
        const mainPage = await client.readPage(config.basePath);
        const { parseWikiRanges } = require('./markdown-gen');
        const wikiRanges = parseWikiRanges(mainPage.content);
        if (wikiRanges && wikiRanges.length > 0) {
          cachedWikiRanges = wikiRanges;
        } else {
          cachedWikiRanges = null;
        }

        lastWikiCacheUpdate = now;
      } catch (e) {
        // ignore
      }
    }

    // Is there a wiki page for this type and id?
    const wikiPage = cachedWikiPages.find(p => {
      const parsed = parseSubPageName(p.path);
      return parsed && parsed.type === typeStr && parsed.id === id;
    });

    if (wikiPage) {
      let isConflict = false;
      let wikiNameStr = cachedWikiNames.get(wikiPage.path);
      
      if (!wikiNameStr) {
        // Prevent concurrent API calls for the same wiki page
        const _globalThis: any = globalThis;
        if (!_globalThis.wikiNamePromises) {
          _globalThis.wikiNamePromises = new Map();
        }
        let namePromise = _globalThis.wikiNamePromises.get(wikiPage.path);
        if (!namePromise) {
          namePromise = client.readPage(wikiPage.path).then(pageData => {
            let name = '';
            const headerMatch = /^#\s*(.*)/m.exec(pageData.content);
            if (headerMatch) {
              name = headerMatch[1].trim();
              cachedWikiNames.set(wikiPage.path, name);
            }
            return name;
          }).catch(() => {
            return '';
          }).finally(() => {
            _globalThis.wikiNamePromises.delete(wikiPage.path);
          });
          _globalThis.wikiNamePromises.set(wikiPage.path, namePromise);
        }
        wikiNameStr = await namePromise;
      }

      if (wikiNameStr && wikiNameStr !== 'Reservation') {
        const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (simplify(name) !== simplify(wikiNameStr)) {
          isConflict = true;
          const diag = new vscode.Diagnostic(
            range,
            `Harter Konflikt: Lokal '${name}', im Wiki ist diese ID als '${wikiNameStr}' reserviert.`,
            vscode.DiagnosticSeverity.Error
          );
          diag.source = 'IDSamurai';
          diag.code = { value: 'IDS003', target: vscode.Uri.parse('https://github.com/rpinkau/IDSamurai#ids003') };
          diagnostics.push(diag);
        }
      }
    }
  }

  idDiagnosticCollection.set(document.uri, diagnostics);
}

export function clearDiagnostics(document: vscode.TextDocument) {
  idDiagnosticCollection.delete(document.uri);
}

export function subscribeToDocumentChanges(
  context: vscode.ExtensionContext,
  diagnosticCollection: vscode.DiagnosticCollection,
  getConfig: () => Config | null,
  getClient: () => WikiClient | null
): void {
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const debouncedRefresh = (document: vscode.TextDocument) => {
    if (document.languageId !== 'al') return;
    const key = document.uri.toString();
    const existingTimer = debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      refreshDiagnostics(document, getConfig(), getClient());
    }, 500);
    debounceTimers.set(key, timer);
  };

  if (vscode.window.activeTextEditor) {
    debouncedRefresh(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        debouncedRefresh(editor.document);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      debouncedRefresh(e.document);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      const key = doc.uri.toString();
      const existingTimer = debounceTimers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
        debounceTimers.delete(key);
      }
      diagnosticCollection.delete(doc.uri);
    })
  );
}
