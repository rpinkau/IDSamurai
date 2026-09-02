import { AlObject, TableField, PageField, ObjectRange, AppRanges } from './al-parser';
import { Config, buildPageUrl } from './config';

// Typen die eigene Sub-Pages bekommen
const TYPES_WITH_SUBPAGES = new Set(['table', 'tableextension', 'page', 'pageextension']);

// Anzeige-Labels für Objekttypen (alphabetisch sortiert)
const TYPE_LABELS: Record<string, string> = {
  codeunit: 'Codeunits',
  enum: 'Enums',
  enumextension: 'Enum Extensions',
  page: 'Pages',
  pageextension: 'Page Extensions',
  permissionset: 'Permission Sets',
  query: 'Queries',
  report: 'Reports',
  reportextension: 'Report Extensions',
  table: 'Tables',
  tableextension: 'Table Extensions',
  xmlport: 'XMLports',
};

// Reihenfolge alphabetisch nach Label
const TYPE_ORDER = Object.keys(TYPE_LABELS).sort((a, b) =>
  TYPE_LABELS[a].localeCompare(TYPE_LABELS[b])
);

/**
 * Erzeugt den Markdown-Inhalt der Hauptseite (Objekt-IDs Übersicht).
 *
 * @param objects  Alle geparsten AL-Objekte
 * @param appRanges  Ranges aus .objidconfig / app.json
 * @param config   Extension-Config (für Link-Erzeugung)
 * @param existingRangesSection  Falls vorhanden: bestehender ## ID-Ranges Abschnitt (wird 1:1 erhalten)
 */
export function generateObjectPageMarkdown(
  objects: AlObject[],
  appRanges: AppRanges[],
  config: Config,
  existingRangesSection?: string,
): string {
  const today = new Date().toISOString().split('T')[0]; // yyyy-MM-dd
  const lines: string[] = [];

  lines.push('# Objekt-IDs');
  lines.push('');
  lines.push(`> Automatisch generiert aus dem Quellcode. Stand: ${today}`);
  lines.push('');

  // Ranges-Abschnitt: entweder bestehenden erhalten oder neu generieren
  if (existingRangesSection) {
    lines.push(existingRangesSection.trimEnd());
    lines.push('');
  } else if (appRanges.some(ar => Object.keys(ar.ranges).length > 0)) {
    lines.push('## ID-Ranges (freie Bereiche)');
    lines.push('');
    lines.push('> Initialbefüllung aus `.objidconfig`. Wird manuell gepflegt.');
    lines.push('');
    lines.push('| App | Typ | Von | Bis | Name |');
    lines.push('|-----|-----|-----|-----|------|');

    for (const ar of appRanges) {
      for (const [objType, ranges] of Object.entries(ar.ranges)) {
        for (const range of ranges) {
          lines.push(`| ${ar.app} | ${objType} | ${range.from} | ${range.to} | ${range.description} |`);
        }
      }
    }
    lines.push('');
  } else {
    // Wenn gar keine Ranges da sind: Dummy anlegen
    lines.push('## ID-Ranges (freie Bereiche)');
    lines.push('');
    lines.push('> Initiale Dummy-Ranges. Bitte manuell anpassen!');
    lines.push('');
    lines.push('| App | Typ | Von | Bis | Name |');
    lines.push('|-----|-----|-----|-----|------|');
    for (const typeName of TYPE_ORDER) {
      lines.push(`| IDSamurai | ${typeName} | 50000 | 50100 | Dummy |`);
    }
    lines.push('');
  }

  // Objekte gruppieren nach Typ
  const byType = new Map<string, AlObject[]>();
  for (const obj of objects) {
    const type = obj.type.toLowerCase();
    if (!byType.has(type)) {
      byType.set(type, []);
    }
    byType.get(type)!.push(obj);
  }

  // Typen alphabetisch nach Label, innerhalb nach ID
  for (const typeName of TYPE_ORDER) {
    const group = byType.get(typeName);
    if (!group || group.length === 0) {
      continue;
    }

    group.sort((a, b) => a.id - b.id);
    const label = TYPE_LABELS[typeName] ?? typeName;
    const hasSubPage = TYPES_WITH_SUBPAGES.has(typeName);

    lines.push(`## ${label}`);
    lines.push('');
    lines.push('| App | Typ | ID | Name | Beschreibung |');
    lines.push('|-----|-----|----|------|--------------|');

    for (const obj of group) {
      const idCell = hasSubPage
        ? `[${obj.id}](${buildPageUrl(config, `${config.basePath}/${typeName}-${obj.id}`)})`
        : `${obj.id}`;
      const desc = obj.summary ? obj.summary.split('\n')[0].substring(0, 100) : '';
      lines.push(`| ${obj.app} | ${typeName} | ${idCell} | ${obj.name} | ${desc} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Erzeugt den Markdown-Inhalt einer Sub-Page für eine Table oder TableExtension.
 */
export function generateTableFieldPageMarkdown(
  obj: AlObject,
  fields: TableField[],
): string {
  const lines: string[] = [];

  lines.push(`# ${obj.type} ${obj.id} – ${obj.name}`);
  lines.push('');

  if (obj.summary) {
    lines.push('> ' + obj.summary.replace(/\n/g, '\n> '));
    lines.push('');
  }

  if (fields.length === 0) {
    lines.push('*Keine Felder gefunden.*');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('| Field ID | Field Name | Data Type | Field Class |');
  lines.push('|----------|------------|-----------|-------------|');

  for (const field of fields) {
    lines.push(`| ${field.id} | ${field.name} | ${field.dataType} | ${field.fieldClass} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Erzeugt den Markdown-Inhalt einer Sub-Page für eine Page oder PageExtension.
 */
export function generatePageFieldPageMarkdown(
  obj: AlObject,
  fields: PageField[],
): string {
  const lines: string[] = [];

  lines.push(`# ${obj.type} ${obj.id} – ${obj.name}`);
  lines.push('');

  if (obj.summary) {
    lines.push('> ' + obj.summary.replace(/\n/g, '\n> '));
    lines.push('');
  }

  if (fields.length === 0) {
    lines.push('*Keine Felder gefunden.*');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('| Caption | Source Expression |');
  lines.push('|---------|-------------------|');

  for (const field of fields) {
    lines.push(`| ${field.caption} | ${field.sourceExpression} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Extrahiert den ## ID-Ranges Abschnitt aus einer bestehenden Hauptseite.
 * Gibt den Abschnitt zurück (inkl. H2-Überschrift), oder undefined wenn nicht gefunden.
 *
 * Start: Zeile die mit "## ID-Ranges" beginnt (oder "## Ranges")
 * Ende:  Nächste H2-Überschrift ("## ") oder Dateiende
 */
export function extractRangesSection(existingContent: string): string | undefined {
  const lines = existingContent.split('\n');
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (start === -1) {
      if (line.startsWith('## ID-Ranges') || line.startsWith('## Ranges')) {
        start = i;
      }
    } else {
      // Nächste H2 → Ende des Ranges-Abschnitts
      if (line.startsWith('## ')) {
        end = i;
        break;
      }
    }
  }

  if (start === -1) {
    return undefined;
  }

  return lines.slice(start, end).join('\n');
}

/**
 * Gibt den deterministischen Sub-Page-Pfad für ein AL-Objekt zurück.
 * z.B. "/Inhalt/Objekt-IDs/table-55000"
 */
export function getSubPagePath(basePath: string, obj: AlObject): string {
  return `${basePath}/${obj.type.toLowerCase()}-${obj.id}`;
}

/**
 * Prüft ob ein AL-Objekt eine Sub-Page bekommt.
 */
export function hasSubPage(obj: AlObject): boolean {
  return TYPES_WITH_SUBPAGES.has(obj.type.toLowerCase());
}

/**
 * Gibt alle Sub-Page-fähigen Objekttypen zurück.
 */
export function getSubPageTypes(): string[] {
  return [...TYPES_WITH_SUBPAGES];
}

/**
 * Parst den Typ und die ID aus einem Sub-Page-Pfad-Namen.
 * z.B. "table-55000" → { type: "table", id: 55000 }
 */
export function parseSubPageName(pagePath: string): { type: string; id: number } | null {
  const name = pagePath.split('/').pop() ?? '';
  const match = /^([a-z]+)-(\d+)$/i.exec(name);
  if (!match) {
    return null;
  }
  return { type: match[1], id: parseInt(match[2], 10) };
}

/**
 * Parst manuell eingefügte Objekte aus der Hauptseite (Markdown).
 */
export function parseMainPageObjects(markdown: string): AlObject[] {
  const objects: AlObject[] = [];
  // Suche nach Tabellenzeilen: | App | Typ | ID | Name |
  // Beispiel: | My App | codeunit | 50000 | My Codeunit |
  const lines = markdown.split('\n');
  for (const line of lines) {
    const match = /^\|\s*([^|]*?)\s*\|\s*([a-zA-Z\s]+)\s*\|\s*([\d.,]+)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line.trim());
    if (match) {
      const type = match[2].replace(/\s/g, '').toLowerCase();
      // Überspringe den Tabellen-Header
      if (type === 'typ') continue;

      const id = parseInt(match[3].replace(/[.,]/g, ''), 10);
      if (isNaN(id)) continue;

      objects.push({
        app: match[1].trim(),
        type: type,
        id: id,
        name: match[4],
        filePath: '' // Wiki object
      });
    }
  }
  return objects;
}

/**
 * Parst manuell eingefügte ID-Ranges aus der Hauptseite (Markdown).
 */
export function parseWikiRanges(markdown: string): AppRanges[] {
  const appMap = new Map<string, AppRanges>();

  const rangesSection = extractRangesSection(markdown);
  if (!rangesSection) return [];

  // Suche nach Tabellenzeilen: | App | Typ | Von | Bis | Beschreibung |
  // Beispiel: | My App | codeunit | 50000 | 50100 | ... |
  const lines = rangesSection.split('\n');
  for (const line of lines) {
    const match = /\|\s*([^|]*?)\s*\|\s*([a-zA-Z\s]+)\s*\|\s*([\d.,]+)\s*\|\s*([\d.,]+)\s*\|/.exec(line.trim());
    if (match) {
      const app = match[1].trim();
      const type = match[2].replace(/\s/g, '').toLowerCase();
      // Überspringe den Tabellen-Header
      if (type === 'typ') continue;

      const from = parseInt(match[3].replace(/[.,]/g, ''), 10);
      const to = parseInt(match[4].replace(/[.,]/g, ''), 10);

      // description auslesen falls vorhanden
      const descMatch = /\|\s*[^|]*?\s*\|\s*[a-zA-Z\s]+\s*\|\s*[\d.,]+\s*\|\s*[\d.,]+\s*\|\s*(.*?)\s*\|/.exec(line.trim());
      const description = descMatch ? descMatch[1].trim() : '';

      if (!appMap.has(app)) {
        appMap.set(app, { app, ranges: {} });
      }

      const appRanges = appMap.get(app)!;
      if (!appRanges.ranges[type]) {
        appRanges.ranges[type] = [];
      }

      appRanges.ranges[type].push({ from, to, description });
    }
  }

  return Array.from(appMap.values());
}

/**
 * Parst Tabellenfelder aus dem Markdown-Content zurück in AlField Objekte.
 */
export function parseTableFieldsFromWiki(content: string): { id: number; name: string }[] {
  const fields: { id: number; name: string }[] = [];
  const lines = content.split('\n');
  let inTable = false;
  
  for (const line of lines) {
    if (line.startsWith('| ID | Name')) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith('|---')) {
      continue;
    }
    if (inTable && line.startsWith('|')) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 3) {
        const idStr = parts[1];
        const nameStr = parts[2];
        const id = parseInt(idStr, 10);
        if (!isNaN(id)) {
          fields.push({ id, name: nameStr });
        }
      }
    } else if (inTable && line.trim() === '') {
      inTable = false;
    }
  }
  return fields;
}
