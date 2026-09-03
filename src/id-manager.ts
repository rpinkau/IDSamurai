import { AlObject, ObjectRange, AppRanges } from './al-parser';
import { WikiClient, WikiPageRef } from './wiki-client';
import { Config } from './config';
import { parseSubPageName, getSubPagePath } from './markdown-gen';

export interface Logger {
  appendLine(value: string): void;
}

export interface IdSuggestion {
  type: string;
  nextFreeId: number;
  range: ObjectRange;
  app: string;
  usedCount: number;
  freeCount: number;
}

export interface RangeStats {
  app: string;
  type: string;
  range: ObjectRange;
  usedCount: number;
  freeCount: number;
  usedIds: number[];
}

/**
 * Berechnet die nächste freie ID für einen Objekttyp aus den konfigurierten Ranges.
 * Berücksichtigt alle bereits belegten IDs aus den geparsten AL-Objekten.
 */
export function getNextFreeId(
  type: string,
  objects: AlObject[],
  appRanges: AppRanges[],
  targetApp?: string
): IdSuggestion | null {
  const normalizedType = type.toLowerCase();

  // Alle belegten IDs für diesen Typ sammeln
  const usedIds = new Set(
    objects
      .filter(o => o.type.toLowerCase() === normalizedType)
      .map(o => o.id)
  );

  // Durch alle Apps und deren Ranges iterieren
  for (const ar of appRanges) {
    if (targetApp) {
      const arAppClean = ar.app.replace(/\s+/g, '').toLowerCase();
      const targetAppClean = targetApp.replace(/\s+/g, '').toLowerCase();
      if (arAppClean !== targetAppClean) {
        continue;
      }
    }

    const typeRanges = ar.ranges[normalizedType];
    if (!typeRanges || typeRanges.length === 0) {
      continue;
    }

    for (const range of typeRanges) {
      for (let id = range.from; id <= range.to; id++) {
        if (!usedIds.has(id)) {
          let freeCount = 0;
          let usedCount = 0;
          for (let checkId = range.from; checkId <= range.to; checkId++) {
            if (!usedIds.has(checkId)) freeCount++;
            else usedCount++;
          }
          return {
            type: normalizedType,
            nextFreeId: id,
            range,
            app: ar.app,
            usedCount,
            freeCount,
          };
        }
      }
    }
  }

  return null; // Alle Ranges voll
}

export async function getNextFreeIdWithWiki(
  type: string,
  localObjects: AlObject[],
  configRanges: AppRanges[],
  client: WikiClient,
  config: Config,
  cachedWikiSubPages?: WikiPageRef[],
  cachedMainPageContent?: string,
  targetApp?: string
): Promise<IdSuggestion | null> {
  let appRanges = configRanges;

  // 1. Hole Wiki-Seiten (für reservierte IDs)
  let wikiSubPages: WikiPageRef[] = cachedWikiSubPages ?? [];
  if (!cachedWikiSubPages) {
    try {
      wikiSubPages = await client.listSubPages(config.basePath);
    } catch (e) {
      // ignorieren, wir machen ohne weiter
    }
  }

  // 2. Hole Hauptseite (für Ranges)
  let mainPageContent = cachedMainPageContent;
  if (!cachedMainPageContent) {
    try {
      const mainPage = await client.readPage(config.basePath);
      mainPageContent = mainPage.content;
    } catch (e: any) {
      throw new Error(`Wiki-Fehler: Konnte Hauptseite nicht lesen. ${e.message || ''}`);
    }
  }

  const { parseMainPageObjects, parseWikiRanges } = require('./markdown-gen');

  if (mainPageContent) {
    // Wiki-Ranges bevorzugen, falls in der Tabelle gepflegt!
    const wikiRanges = parseWikiRanges(mainPageContent);
    if (wikiRanges.length > 0) {
      appRanges = JSON.parse(JSON.stringify(wikiRanges)); // Überschreibe lokale config ranges als tiefe Kopie (M4)
    }

    let combinedObjects = [...localObjects];
    const mainPageObjects = parseMainPageObjects(mainPageContent);
    for (const mo of mainPageObjects) {
      if (!combinedObjects.find(o => o.type.toLowerCase() === mo.type.toLowerCase() && o.id === mo.id)) {
        combinedObjects.push({ app: mo.app, type: mo.type, id: mo.id, name: mo.name, filePath: '' });
      }
    }
    localObjects = combinedObjects;
  }

  const normalizedType = type.toLowerCase();
  const wikiUsedIds = new Set<number>();
  for (const page of wikiSubPages) {
    const parsed = parseSubPageName(page.path);
    if (parsed && parsed.type === normalizedType) {
      wikiUsedIds.add(parsed.id);
    }
  }

  const localUsedIds = localObjects
    .filter(o => o.type.toLowerCase() === normalizedType)
    .map(o => o.id);
  
  const allUsedIds = new Set([...localUsedIds, ...wikiUsedIds]);

  let suggestion: IdSuggestion | null = null;
  outer: for (const ar of appRanges) {
    if (targetApp) {
      const arAppClean = ar.app.replace(/\s+/g, '').toLowerCase();
      const targetAppClean = targetApp.replace(/\s+/g, '').toLowerCase();
      if (arAppClean !== targetAppClean) {
        continue;
      }
    }

    const typeRanges = ar.ranges[normalizedType];
    if (!typeRanges) continue;
    
    for (const range of typeRanges) {
      for (let id = range.from; id <= range.to; id++) {
        if (!allUsedIds.has(id)) {
          let freeCount = 0;
          let usedCount = 0;
          for (let checkId = range.from; checkId <= range.to; checkId++) {
            if (!allUsedIds.has(checkId)) freeCount++;
            else usedCount++;
          }
          suggestion = {
            type: normalizedType,
            nextFreeId: id,
            range,
            app: ar.app,
            usedCount,
            freeCount
          };
          break outer;
        }
      }
    }
  }
  return suggestion;
}

/**
 * Reserviert die nächste freie ID sicher im Wiki über Optimistic Concurrency Control (ETags).
 * Nutzt Option A: Echte leere Placeholder-Unterseiten im Wiki.
 */
export async function reserveId(
  type: string,
  objects: AlObject[],
  appRanges: AppRanges[],
  client: WikiClient,
  config: Config,
  cachedWikiSubPages?: WikiPageRef[],
  cachedMainPageContent?: string,
  featureName?: string,
  targetApp?: string
): Promise<IdSuggestion | null> {
  let retries = 5;

  while (retries > 0) {
    retries--;

    const suggestion = await getNextFreeIdWithWiki(type, objects, appRanges, client, config, cachedWikiSubPages, cachedMainPageContent, targetApp);
    if (!suggestion) {
      return null; // Keine freie ID mehr in den Ranges
    }

    // Platzhalter-Pfad generieren
    const mockObj: AlObject = { type: suggestion.type, id: suggestion.nextFreeId, name: 'Reservation', filePath: '', app: suggestion.app };
    const pagePath = getSubPagePath(config.basePath, mockObj);

    let branchText = '';
    try {
      const { getCurrentGitBranch } = require('./git');
      const cwd = config.appSources?.[0]?.configDir || process.cwd();
      const branch = await getCurrentGitBranch(config, cwd);
      if (branch) {
        branchText = ` auf Branch **${branch}**`;
      }
    } catch {
      // ignore
    }

    // Reservation-Tag mit zufälliger ID für Race-Condition Erkennung
    const now = new Date().toISOString();
    const lockId = Math.random().toString(36).substring(2, 15);
    const featureText = featureName ? ` für "${featureName}"` : '';
    const content = `> ⏳ Diese ID wurde am ${now}${branchText}${featureText} reserviert und wartet auf Code.\n\n<!-- IDSAMURAI_RESERVATION: ${now} LOCK: ${lockId} -->`;

    // Vorab prüfen, ob die Seite schon existiert, um blinde Überschreiber zu vermeiden (K2)
    try {
      await client.readPage(pagePath);
      // Seite existiert bereits -> jemand war schneller, retry!
      continue;
    } catch {
      // 404 -> Seite existiert nicht, wir können versuchen sie zu erstellen
    }

    // writePageStrict mit etag=undefined
    const success = await client.writePageStrict(pagePath, content, undefined);
    if (success) {
      // WICHTIG: Azure DevOps Wiki schützt nicht vor Race Conditions bei der Erstellung (ohne If-Match).
      // Wir lesen die Seite direkt danach wieder aus und prüfen, ob unser Lock-ID drin steht.
      try {
        const checkPage = await client.readPage(pagePath);
        if (checkPage.content.includes(`LOCK: ${lockId}`)) {
          return suggestion;
        }
      } catch (e) {
        // Fehler beim Zurücklesen -> wir nehmen an, dass es fehlgeschlagen ist
      }
    }
    // 412 Conflict -> Loop wiederholt sich, liest neu und zieht ggf. nächste ID
  }

  throw new Error('Konnte ID nicht reservieren: Zu viele Konflikte (412). Bitte erneut versuchen.');
}

/**
 * Liefert Statistiken für alle konfigurierten Ranges und Typen.
 */
export function getRangeStats(
  objects: AlObject[],
  appRanges: AppRanges[],
): RangeStats[] {
  const stats: RangeStats[] = [];

  for (const ar of appRanges) {
    for (const [objType, ranges] of Object.entries(ar.ranges)) {
      const normalizedType = objType.toLowerCase();

      // Alle belegten IDs für diesen Typ
      const appObjects = objects.filter(
        o => o.type.toLowerCase() === normalizedType
      );
      const usedIds = appObjects.map(o => o.id).sort((a, b) => a - b);
      const usedSet = new Set(usedIds);

      for (const range of ranges) {
        const idsInRange = usedIds.filter(id => id >= range.from && id <= range.to);
        const totalInRange = range.to - range.from + 1;

        // Prüfe wie viele IDs im Range frei sind
        let freeCount = 0;
        for (let id = range.from; id <= range.to; id++) {
          if (!usedSet.has(id)) {
            freeCount++;
          }
        }

        stats.push({
          app: ar.app,
          type: normalizedType,
          range,
          usedCount: idsInRange.length,
          freeCount,
          usedIds: idsInRange,
        });
      }
    }
  }

  return stats;
}

/**
 * Liefert Statistiken für alle konfigurierten Ranges und Typen, und bezieht dabei das Wiki ein.
 */
export async function getRangeStatsWithWiki(
  objects: AlObject[],
  appRanges: AppRanges[],
  client: WikiClient,
  config: Config,
  outputChannel?: Logger
): Promise<RangeStats[]> {
  if (outputChannel) {
    outputChannel.appendLine(`[Ranges] Starte Ermittlung der freien Ranges aus Wiki-Seite: ${config.basePath}`);
  }

  // 1. Wiki-IDs auslesen
  let wikiSubPages: any[] = [];
  try {
    wikiSubPages = await client.listSubPages(config.basePath);
  } catch (e: any) {
    if (outputChannel) {
      outputChannel.appendLine(`[Ranges] Fehler beim Lesen der Subpages: ${e.message}`);
    }
  }

  const { parseSubPageName } = require('./markdown-gen');
  const wikiUsedIdsByType = new Map<string, Set<number>>();

  const addWikiId = (type: string, id: number) => {
    const normType = type.toLowerCase();
    if (!wikiUsedIdsByType.has(normType)) wikiUsedIdsByType.set(normType, new Set());
    wikiUsedIdsByType.get(normType)!.add(id);
  };

  for (const page of wikiSubPages) {
    const parsed = parseSubPageName(page.path);
    if (parsed) {
      addWikiId(parsed.type, parsed.id);
    }
  }

  const { parseMainPageObjects, parseWikiRanges } = require('./markdown-gen');
  let mainPageContent = '';
  try {
    const mainPage = await client.readPage(config.basePath);
    mainPageContent = mainPage.content;
    const mainPageObjects = parseMainPageObjects(mainPageContent);
    if (outputChannel) {
      outputChannel.appendLine(`[Ranges] Fand ${mainPageObjects.length} Objekte direkt auf der Wiki-Seite.`);
    }
    for (const obj of mainPageObjects) {
      addWikiId(obj.type, obj.id);
    }
  } catch (e: any) {
    if (outputChannel) {
      outputChannel.appendLine(`[Ranges] Fehler beim Lesen der Hauptseite: ${e.message}`);
    }
  }

  // Wiki-Ranges bevorzugen, falls in der Tabelle gepflegt!
  if (mainPageContent) {
    const wikiRanges = parseWikiRanges(mainPageContent);
    if (wikiRanges.length > 0) {
      if (outputChannel) {
        outputChannel.appendLine(`[Ranges] Fand ${wikiRanges.length} App-Range-Definitionen in der Wiki-Tabelle. Diese überschreiben lokale ranges.`);
      }
      appRanges = JSON.parse(JSON.stringify(wikiRanges)); // Überschreibe lokale config ranges (M4)
    } else {
      if (outputChannel) {
        outputChannel.appendLine(`[Ranges] WARNUNG: Keine Ranges in der Wiki-Tabelle gefunden! Prüfe das Tabellenformat.`);
      }
    }
  }

  // 2. Stats berechnen
  const stats: RangeStats[] = [];

  for (const ar of appRanges) {
    for (const [objType, ranges] of Object.entries(ar.ranges)) {
      const normalizedType = objType.toLowerCase();

      // Alle belegten IDs für diesen Typ
      const appObjects = objects.filter(
        o => o.type.toLowerCase() === normalizedType
      );
      const localUsedIds = appObjects.map(o => o.id);
      const wikiUsedIds = Array.from(wikiUsedIdsByType.get(normalizedType) || []);
      
      const allUsedSet = new Set([...localUsedIds, ...wikiUsedIds]);
      const allUsedSorted = Array.from(allUsedSet).sort((a, b) => a - b);

      for (const range of ranges) {
        const idsInRange = allUsedSorted.filter(id => id >= range.from && id <= range.to);

        let freeCount = 0;
        for (let id = range.from; id <= range.to; id++) {
          if (!allUsedSet.has(id)) {
            freeCount++;
          }
        }

        stats.push({
          app: ar.app,
          type: normalizedType,
          range,
          usedCount: idsInRange.length,
          freeCount,
          usedIds: idsInRange,
        });
      }
    }
  }

  return stats;
}

/**
 * Gibt alle Objekttypen zurück, für die Ranges definiert sind.
 */
export function getTypesWithRanges(appRanges: AppRanges[]): string[] {
  const types = new Set<string>();
  for (const ar of appRanges) {
    for (const objType of Object.keys(ar.ranges)) {
      types.add(objType.toLowerCase());
    }
  }
  return [...types].sort();
}

/**
 * Formatiert eine RangeStats Zeile für den Output Channel.
 */
export function formatRangeStats(stats: RangeStats[]): string[] {
  const lines: string[] = [];
  lines.push('ID-Ranges Übersicht:');
  lines.push('═'.repeat(60));

  let lastApp = '';
  for (const s of stats) {
    if (s.app !== lastApp) {
      lines.push('');
      lines.push(`App: ${s.app}`);
      lines.push('─'.repeat(40));
      lastApp = s.app;
    }
    const pct = Math.round((s.usedCount / (s.usedCount + s.freeCount)) * 100);
    lines.push(
      `  ${s.type.padEnd(20)} ${s.range.from}-${s.range.to}` +
      `  ${s.usedCount} belegt, ${s.freeCount} frei (${pct}%)` +
      (s.range.description ? `  [${s.range.description}]` : '')
    );
  }

  return lines;
}
