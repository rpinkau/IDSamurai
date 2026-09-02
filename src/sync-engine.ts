import * as vscode from 'vscode';
import { Config } from './config';
import { WikiClient, WikiPageRef, sleep } from './wiki-client';
import {
  AlObject,
  parseObjectsFromConfig,
  parseTableFields,
  parsePageFields,
  parseRanges,
  invalidateCache,
} from './al-parser';
import {
  generateObjectPageMarkdown,
  generateTableFieldPageMarkdown,
  generatePageFieldPageMarkdown,
  extractRangesSection,
  getSubPagePath,
  hasSubPage,
  parseSubPageName,
} from './markdown-gen';
import * as fs from 'fs';
import * as path from 'path';
import { resolvePath } from './config';

export interface SyncResult {
  added: number;
  removed: number;
  updated: number;
  unchanged: number;
  errors: number;
  details: string[];
}

const RATE_LIMIT_DELAY = 150; // ms zwischen Requests

/**
 * Kompletter Rebuild: Löscht keine bestehenden Seiten, überschreibt einfach alles.
 * Liest bestehende Hauptseite um Ranges-Abschnitt zu erhalten.
 */
export async function rebuild(
  config: Config,
  client: WikiClient,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<SyncResult> {
  const result: SyncResult = { added: 0, removed: 0, updated: 0, unchanged: 0, errors: 0, details: [] };

  progress.report({ message: 'AL-Objekte einlesen…' });
  invalidateCache();
  const objects = parseObjectsFromConfig(config);
  const appRanges = parseRanges(config);

  if (objects.length === 0) {
    result.details.push('Keine AL-Objekte gefunden.');
    return result;
  }

  result.details.push(`${objects.length} AL-Objekte gefunden.`);

  // Sub-Pages (objects mit Sub-Pages)
  const subPageObjects = objects.filter(o => hasSubPage(o));
  const total = subPageObjects.length + 1; // +1 für Hauptseite
  let done = 0;

  if (token.isCancellationRequested) {
    return result;
  }

  // Hauptseite schreiben
  progress.report({ message: 'Hauptseite generieren…', increment: 0 });
  try {
    const { parseMainPageObjects } = require('./markdown-gen');
    await client.updatePage(config.basePath, (currentContent) => {
      let existingRangesSection: string | undefined;
      
      if (currentContent) {
        existingRangesSection = extractRangesSection(currentContent);
        // mainPageObjects ignorieren wir im Rebuild, da die Codebase der Master ist.
      }

      return generateObjectPageMarkdown(objects, appRanges, config, existingRangesSection);
    });

    result.updated++;
    result.details.push(`✓ Hauptseite: ${config.basePath}`);
  } catch (e) {
    result.errors++;
    result.details.push(`✗ Hauptseite FEHLER: ${e}`);
  }
  done++;
  await sleep(RATE_LIMIT_DELAY);

  // Veraltete Sub-Pages löschen
  progress.report({ message: 'Veraltete Wiki-Seiten aufräumen…', increment: 0 });
  try {
    const wikiSubPages = await client.listSubPages(config.basePath);
    const expectedPaths = new Set(subPageObjects.map(o => getSubPagePath(config.basePath, o)));
    
    for (const page of wikiSubPages) {
      if (token.isCancellationRequested) break;
      
      const parsed = parseSubPageName(page.path);
      if (!parsed) continue;
      
      if (!expectedPaths.has(page.path)) {
        // Im Wiki vorhanden, aber nicht mehr lokal -> gnadenlos löschen (Codebase is Master)
        
        try {
          await client.deletePage(page.path);
          result.removed++;
          result.details.push(`✓ Gelöscht (obsolet): ${page.path}`);
        } catch (e) {
          result.errors++;
          result.details.push(`✗ Fehler beim Löschen von ${page.path}: ${e}`);
        }
        await sleep(RATE_LIMIT_DELAY);
      }
    }
  } catch (e) {
    result.details.push(`Fehler beim Prüfen auf veraltete Seiten: ${e}`);
  }

  // Sub-Pages schreiben
  for (const obj of subPageObjects) {
    if (token.isCancellationRequested) {
      result.details.push('Rebuild abgebrochen.');
      break;
    }

    const increment = Math.floor((100 / total));
    progress.report({ message: `${obj.type}-${obj.id}: ${obj.name}`, increment });

    const subPath = getSubPagePath(config.basePath, obj);
    try {
      let markdown: string;
      if (obj.type === 'table' || obj.type === 'tableextension') {
        const fields = parseTableFields(obj.filePath);
        markdown = generateTableFieldPageMarkdown(obj, fields);
      } else {
        const fields = parsePageFields(obj.filePath);
        markdown = generatePageFieldPageMarkdown(obj, fields);
      }
      await client.writePage(subPath, markdown);
      result.updated++;
      result.details.push(`✓ ${obj.type}-${obj.id}: ${obj.name}`);
    } catch (e) {
      result.errors++;
      result.details.push(`✗ ${obj.type}-${obj.id} FEHLER: ${e}`);
    }

    done++;
    await sleep(RATE_LIMIT_DELAY);
  }

  return result;
}

/**
 * Intelligenter Sync: Diff zwischen Quellcode (Soll) und Wiki (Ist).
 * - Neu in Source → Sub-Page erstellen
 * - Im Wiki, nicht in Source → Sub-Page löschen
 * - In beiden → Inhaltsvergleich → bei Änderung aktualisieren
 *
 * @param dryRun Wenn true: keine Writes/Deletes, nur Report
 */
export async function sync(
  config: Config,
  client: WikiClient,
  dryRun: boolean,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<SyncResult> {
  const result: SyncResult = { added: 0, removed: 0, updated: 0, unchanged: 0, errors: 0, details: [] };
  const dryPrefix = dryRun ? '[DRY-RUN] ' : '';

  progress.report({ message: 'AL-Objekte einlesen…' });
  invalidateCache();
  const objects = parseObjectsFromConfig(config);
  const appRanges = parseRanges(config);

  if (objects.length === 0) {
    result.details.push('Keine AL-Objekte gefunden.');
    return result;
  }

  // Soll-Zustand: AL-Objekte mit Sub-Pages
  const subPageObjects = objects.filter(o => hasSubPage(o));
  const sourceMap = new Map<string, AlObject>();
  for (const obj of subPageObjects) {
    const subPath = getSubPagePath(config.basePath, obj);
    sourceMap.set(subPath, obj);
  }

  // Ist-Zustand: Existierende Sub-Pages im Wiki
  progress.report({ message: 'Wiki Sub-Pages laden…' });
  let wikiSubPages: WikiPageRef[] = [];
  try {
    wikiSubPages = await client.listSubPages(config.basePath);
  } catch (e) {
    result.errors++;
    result.details.push(`Fehler beim Laden der Wiki Sub-Pages: ${e}`);
    return result;
  }

  const wikiMap = new Map<string, WikiPageRef>();
  for (const page of wikiSubPages) {
    wikiMap.set(page.path, page);
  }

  const total = sourceMap.size + wikiMap.size + 1; // rough estimate
  let done = 0;

  // 1. Zu löschende Seiten (im Wiki, nicht in Source)
  for (const [wikiPath, wikiPage] of wikiMap) {
    if (token.isCancellationRequested) {
      break;
    }

    const parsed = parseSubPageName(wikiPath);
    if (!parsed) {
      continue; // Keine Objekt-Sub-Page → ignorieren
    }

    if (!sourceMap.has(wikiPath)) {
      // Prüfen ob es eine aktive Platzhalter-Reservierung ist
      try {
        const existingPage = await client.readPage(wikiPath);
        const match = existingPage.content.match(/<!-- IDSAMURAI_RESERVATION:\s+([^\s>]+)/);
        if (match) {
          const reservationDate = new Date(match[1]);
          const now = new Date();
          const diffMs = now.getTime() - reservationDate.getTime();
          const diffDays = diffMs / (1000 * 60 * 60 * 24);
          
          if (diffDays < 3) {
            // Noch frisch (< 3 Tage) -> nicht löschen
            result.unchanged++;
            continue;
          }
        }
      } catch (e) {
        // Fallback: regulär löschen
      }

      if (dryRun) {
        result.details.push(`${dryPrefix}LÖSCHEN: ${wikiPath}`);
        result.removed++;
      } else {
        try {
          await client.deletePage(wikiPath);
          result.removed++;
          result.details.push(`${dryPrefix}Gelöscht: ${wikiPath}`);
          await sleep(RATE_LIMIT_DELAY);
        } catch (e) {
          result.errors++;
          result.details.push(`✗ Löschen fehlgeschlagen (${wikiPath}): ${e}`);
        }
      }
    }
    done++;
    progress.report({ increment: Math.floor(100 / total) });
  }

  if (token.isCancellationRequested) {
    result.details.push('Sync abgebrochen.');
    return result;
  }

  // 2. Neue / geänderte Sub-Pages
  for (const [subPath, obj] of sourceMap) {
    if (token.isCancellationRequested) {
      break;
    }

    progress.report({ message: `${obj.type}-${obj.id}`, increment: Math.floor(100 / total) });

    let newMarkdown: string;
    try {
      if (obj.type === 'table' || obj.type === 'tableextension') {
        const fields = parseTableFields(obj.filePath);
        newMarkdown = generateTableFieldPageMarkdown(obj, fields);
      } else {
        const fields = parsePageFields(obj.filePath);
        newMarkdown = generatePageFieldPageMarkdown(obj, fields);
      }
    } catch (e) {
      result.errors++;
      result.details.push(`✗ Parse-Fehler (${subPath}): ${e}`);
      continue;
    }

    if (wikiMap.has(subPath)) {
      // Seite existiert → Inhaltsvergleich
      try {
        const existing = await client.readPage(subPath);
        await sleep(RATE_LIMIT_DELAY);

        if (normalizeMarkdown(existing.content) === normalizeMarkdown(newMarkdown)) {
          result.unchanged++;
          continue;
        }

        if (dryRun) {
          result.details.push(`${dryPrefix}ÄNDERN: ${subPath}`);
          result.updated++;
        } else {
          await client.writePage(subPath, newMarkdown);
          result.updated++;
          result.details.push(`✓ Aktualisiert: ${subPath}`);
          await sleep(RATE_LIMIT_DELAY);
        }
      } catch (e) {
        result.errors++;
        result.details.push(`✗ Fehler (${subPath}): ${e}`);
      }
    } else {
      // Neue Seite
      if (dryRun) {
        result.details.push(`${dryPrefix}NEU: ${subPath}`);
        result.added++;
      } else {
        try {
          await client.writePage(subPath, newMarkdown);
          result.added++;
          result.details.push(`✓ Erstellt: ${subPath}`);
          await sleep(RATE_LIMIT_DELAY);
        } catch (e) {
          result.errors++;
          result.details.push(`✗ Erstellen fehlgeschlagen (${subPath}): ${e}`);
        }
      }
    }
    done++;
  }

  if (token.isCancellationRequested) {
    result.details.push('Sync abgebrochen.');
    return result;
  }

  // 3. Hauptseite regenerieren (Ranges-Abschnitt erhalten)
  progress.report({ message: 'Hauptseite aktualisieren…' });
  try {
    if (dryRun) {
      result.details.push(`${dryPrefix}Hauptseite würde aktualisiert: ${config.basePath}`);
      result.updated++;
    } else {
      await syncMainPage(config, client, objects, appRanges);
      result.updated++;
      result.details.push(`✓ Hauptseite aktualisiert: ${config.basePath}`);
    }
  } catch (e) {
    result.errors++;
    result.details.push(`✗ Hauptseite FEHLER: ${e}`);
  }

  return result;
}

/**
 * Aktualisiert die Hauptseite des Wikis (additiver Merge mit manuellen Einträgen).
 */
export async function syncMainPage(
  config: Config,
  client: WikiClient,
  localObjects?: AlObject[],
  localAppRanges?: any[]
): Promise<void> {
  const { parseMainPageObjects } = require('./markdown-gen');
  
  if (!localObjects || !localAppRanges) {
    localObjects = parseObjectsFromConfig(config);
    localAppRanges = parseRanges(config);
  }

  await client.updatePage(config.basePath, (currentContent) => {
    let existingRangesSection: string | undefined;
    let mainPageObjects: AlObject[] = [];
    
    if (currentContent) {
      existingRangesSection = extractRangesSection(currentContent);
      mainPageObjects = parseMainPageObjects(currentContent);
    }

    // Kombiniere lokale Objekte mit manuellen Objekten (die nicht lokal existieren)
    const combinedObjects = [...localObjects!];
    for (const mo of mainPageObjects) {
      if (!localObjects!.some(o => o.type === mo.type && o.id === mo.id)) {
        combinedObjects.push(mo);
      }
    }

    return generateObjectPageMarkdown(combinedObjects, localAppRanges!, config, existingRangesSection);
  });
}

/**
 * Normalisiert Markdown für Vergleich (entfernt trailing whitespace, normalisiert Zeilenenden).
 */
function normalizeMarkdown(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Synchronisiert eine einzelne AL-Datei mit dem Wiki.
 * Wird beim Speichern aufgerufen.
 */
export async function syncSingleFile(
  filePath: string,
  config: Config,
  client: WikiClient
): Promise<boolean> {
  // App-Name ermitteln
  let appName = 'Unknown';
  for (const appSource of config.appSources) {
    const srcPath = resolvePath(appSource, appSource.srcPath);
    if (filePath.startsWith(srcPath) || filePath.startsWith(path.normalize(srcPath))) {
      const appJsonPath = resolvePath(appSource, appSource.appJson);
      if (fs.existsSync(appJsonPath)) {
        try {
          const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
          appName = appJson.name ?? appJson.Name ?? 'Unknown';
        } catch {
          appName = path.basename(path.dirname(appJsonPath));
        }
      }
      break;
    }
  }

  const { parseObjectHeader, parseTableFields, parsePageFields } = require('./al-parser');
  const objs = parseObjectHeader(filePath, appName);
  if (!objs || objs.length === 0) return false;

  let success = true;
  for (const obj of objs) {
    if (!hasSubPage(obj)) continue;

    const subPath = getSubPagePath(config.basePath, obj);
    let markdown: string;
    if (obj.type === 'table' || obj.type === 'tableextension') {
      const fields = parseTableFields(obj.filePath);
      markdown = generateTableFieldPageMarkdown(obj, fields);
    } else {
      const fields = parsePageFields(obj.filePath);
      markdown = generatePageFieldPageMarkdown(obj, fields);
    }

    let etag: string | undefined;
    try {
      const existing = await client.readPage(subPath);
      if (existing && existing.content === markdown) {
         continue; // No change for this object
      }
      etag = existing?.etag;
    } catch (e: any) {
      const { isNetworkError } = require('./sync-queue');
      if (isNetworkError(e)) {
        throw e;
      }
      // Ansonsten: Seite existiert nicht (404), was ok ist
    }

    // Wenn ETag mismatch -> writePageStrict gibt false zurück
    const ok = await client.writePageStrict(subPath, markdown, etag);
    if (!ok) success = false;
  }
  
  return success;
}
