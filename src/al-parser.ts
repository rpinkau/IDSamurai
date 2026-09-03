import * as fs from 'fs';
import * as path from 'path';
import { Config, resolvePath } from './config-core';

export interface AlObject {
  app: string;
  type: string;
  id: number;
  name: string;
  filePath: string;
  line?: number;
  summary?: string;
  fields?: TableField[];
  pageFields?: PageField[];
}

export interface TableField {
  id: number;
  name: string;
  dataType: string;
  fieldClass: string; // Normal, FlowField, FlowFilter
  line?: number;
}

export interface PageField {
  caption: string;
  sourceExpression: string;
  line?: number;
}

export interface ObjectRange {
  from: number;
  to: number;
  description: string;
}

export interface AppRanges {
  app: string;
  ranges: Record<string, ObjectRange[]>; // keyed by object type
}

// Objekt-Header Regex (getestet gegen BC AL Syntax, unterstützt extends und implements)
const OBJ_REGEX =
  /^\s*(table|tableextension|page|pageextension|codeunit|report|enum|enumextension|query|xmlport|permissionset|reportextension)\s+(\d+)\s+(?:"([^"]+)"|([^\s{]+))\s*[^\{]*?\{/igm;

// Table Field: field(ID; "Name"; DataType) {
const TABLE_FIELD_REGEX = /field\(\s*(\d+)\s*;\s*"([^"]+)"\s*;\s*([^)]+?)\s*\)\s*\{/gms;

// FieldClass: FieldClass = FlowField | FlowFilter | Normal
const FIELD_CLASS_REGEX = /FieldClass\s*=\s*(FlowField|FlowFilter|Normal)/i;

// Page Field: field("Caption"; SourceExpr)
const PAGE_FIELD_REGEX = /field\(\s*"([^"]+)"\s*;\s*([^){;,\r\n]+)/gm;

export const parsedObjectsCache = new Map<string, AlObject[]>();
let cacheInitialized = false;

export function invalidateCache() {
  cacheInitialized = false;
  parsedObjectsCache.clear();
}

export function getAppForFile(filePath: string, config: Config): string | undefined {
  let appName: string | undefined = undefined;
  for (const appSource of config.appSources) {
    const srcPath = resolvePath(appSource, appSource.srcPath);
    if (filePath.startsWith(srcPath)) {
      const appJsonPath = resolvePath(appSource, appSource.appJson);
      if (fs.existsSync(appJsonPath)) {
        try {
          const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
          appName = appJson.name ?? appJson.Name;
        } catch { /* ignore */ }
      }
      break;
    }
  }
  return appName;
}

export function updateFileInCache(filePath: string, config: Config) {
  // Finde die zugehörige appSource
  const appName = getAppForFile(filePath, config) ?? 'Unknown';

  
  const objs = parseObjectHeader(filePath, appName);
  if (objs && objs.length > 0) {
    parsedObjectsCache.set(filePath, objs);
  } else {
    parsedObjectsCache.delete(filePath);
  }
}

/**
 * Liest alle AL-Objekte aus allen konfigurierten appSources.
 */
export function parseObjectsFromConfig(config: Config): AlObject[] {
  if (cacheInitialized) {
    return Array.from(parsedObjectsCache.values()).flat();
  }

  const results: AlObject[] = [];
  parsedObjectsCache.clear();

  for (const appSource of config.appSources) {
    const appJsonPath = resolvePath(appSource, appSource.appJson);
    const srcPath = resolvePath(appSource, appSource.srcPath);

    // App-Name aus app.json lesen
    let appName = 'Unknown';
    if (fs.existsSync(appJsonPath)) {
      try {
        const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
        appName = appJson.name ?? appJson.Name ?? 'Unknown';
      } catch {
        // Fallback: Ordnername
        appName = path.basename(path.dirname(appJsonPath));
      }
    }

    if (!fs.existsSync(srcPath)) {
      continue;
    }

    // Alle .al-Dateien rekursiv scannen
    const alFiles = findAlFiles(srcPath);
    for (const filePath of alFiles) {
      const objs = parseObjectHeader(filePath, appName);
      if (objs && objs.length > 0) {
        results.push(...objs);
        parsedObjectsCache.set(filePath, objs);
      }
    }
  }

  cacheInitialized = true;
  return results;
}

/**
 * Parst den Objekt-Header einer einzelnen AL-Datei.
 */
export function parseObjectHeader(filePath: string, app: string): AlObject[] | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    OBJ_REGEX.lastIndex = 0;
    
    const objs: AlObject[] = [];
    let match;
    while ((match = OBJ_REGEX.exec(content)) !== null) {
      const type = match[1].toLowerCase();
      const id = parseInt(match[2], 10);
      const name = (match[3] || match[4] || '').trim();
      // Extract XML Summary
      const textBefore = content.substring(0, match.index);
      const linesBefore = textBefore.split('\n');
      const summaryLines: string[] = [];
      
      for (let i = linesBefore.length - 1; i >= 0; i--) {
        const l = linesBefore[i].trim();
        if (l === '') continue; // Skip empty lines between object and comments
        if (l.startsWith('///')) {
          summaryLines.unshift(l.substring(3).trim());
        } else if (l.startsWith('//')) {
          continue; // Skip normal comments
        } else {
          break; // Stop at any other code
        }
      }
      
      let summary = summaryLines.join('\n').trim();
      summary = summary.replace(/<\/?summary>/gi, '').trim();
      if (!summary) summary = undefined as any;

      const line = linesBefore.length;
      const obj: AlObject = { app, type, id, name, filePath, line, summary };
      if (type === 'table' || type === 'tableextension') {
        obj.fields = parseTableFields(filePath);
      } else if (type === 'page' || type === 'pageextension') {
        obj.pageFields = parsePageFields(filePath);
      }
      objs.push(obj);
    }
    
    return objs.length > 0 ? objs : null;
  } catch {
    return null;
  }
}

/**
 * Parst alle Felder einer Table oder TableExtension AL-Datei.
 */
export function parseTableFields(filePath: string): TableField[] {
  const fields: TableField[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    TABLE_FIELD_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = TABLE_FIELD_REGEX.exec(content)) !== null) {
      const fieldId = parseInt(match[1], 10);
      const fieldName = match[2].trim();
      const dataType = match[3].trim();

      // FieldClass aus dem Block nach der field()-Definition extrahieren
      // Suche im Text ab dem Match bis zur nächsten schließenden }
      const blockStart = match.index + match[0].length;
      const blockEnd = findMatchingBrace(content, blockStart - 1);
      const block = content.substring(blockStart, blockEnd);
      const classMatch = FIELD_CLASS_REGEX.exec(block);
      const fieldClass = classMatch ? classMatch[1] : 'Normal';
      const line = content.substring(0, match.index).split('\n').length;

      fields.push({ id: fieldId, name: fieldName, dataType, fieldClass, line });
    }
  } catch {
    // ignore, return empty
  }
  return fields;
}

/**
 * Parst alle Felder einer Page oder PageExtension AL-Datei.
 */
export function parsePageFields(filePath: string): PageField[] {
  const fields: PageField[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    PAGE_FIELD_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((match = PAGE_FIELD_REGEX.exec(content)) !== null) {
      const caption = match[1].trim();
      const sourceExpr = match[2].trim().replace(/;$/, '').trim();
      const line = content.substring(0, match.index).split('\n').length;

      // Duplikate vermeiden
      const key = `${caption}::${sourceExpr}`;
      if (!seen.has(key)) {
        seen.add(key);
        fields.push({ caption, sourceExpression: sourceExpr, line });
      }
    }
  } catch {
    // ignore, return empty
  }
  return fields;
}

/**
 * Liest ID-Ranges aus .objidconfig oder app.json.
 * Format .objidconfig: { "objectRanges": { "table": [{ "from": X, "to": Y, "description": "..." }] } }
 * Format app.json: { "idRanges": [{ "from": X, "to": Y }] }
 */
export function parseRanges(config: Config): AppRanges[] {
  const result: AppRanges[] = [];

  for (const appSource of config.appSources) {
    const appJsonPath = resolvePath(appSource, appSource.appJson);
    let appName = 'Unknown';
    if (fs.existsSync(appJsonPath)) {
      try {
        const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
        appName = appJson.name ?? appJson.Name ?? 'Unknown';
      } catch { /* ignore */ }
    }

    const ranges: Record<string, ObjectRange[]> = {};

    // 1. Fallback: app.json idRanges (ohne Typ-Unterscheidung → alle Typen)
    if (fs.existsSync(appJsonPath)) {
      try {
        const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
        const idRanges = (appJson['idRanges'] ?? appJson['IdRanges']) as Record<string, unknown>[] | undefined;
        const idRange = (appJson['idRange'] ?? appJson['IdRange']) as Record<string, unknown> | undefined;

        let universalRanges: ObjectRange[] = [];

        if (idRanges && idRanges.length > 0) {
          universalRanges = idRanges.map(r => ({
            from: (r['from'] ?? r['From'] ?? r['startingId'] ?? r['StartingId']) as number,
            to: (r['to'] ?? r['To'] ?? r['endingId'] ?? r['EndingId']) as number,
            description: (r['description'] as string) ?? (r['Description'] as string) ?? '',
          })).filter(r => r.from !== undefined && r.to !== undefined);
        } else if (idRange) {
          const fromVal = idRange['from'] ?? idRange['From'] ?? idRange['startingId'] ?? idRange['StartingId'];
          const toVal = idRange['to'] ?? idRange['To'] ?? idRange['endingId'] ?? idRange['EndingId'];
          if (fromVal !== undefined && toVal !== undefined) {
            universalRanges = [{
              from: fromVal as number,
              to: toVal as number,
              description: (idRange['description'] as string) ?? (idRange['Description'] as string) ?? '',
            }];
          }
        }

        if (universalRanges.length > 0) {
          // Für alle Standard-Typen dieselben Ranges setzen
          for (const t of ['table', 'tableextension', 'page', 'pageextension', 'codeunit', 'report', 'reportextension', 'enum', 'enumextension', 'query', 'xmlport', 'permissionset']) {
            ranges[t] = universalRanges;
          }
        }
      } catch { /* ignore */ }
    }

    // (objIdConfig wurde entfernt)

    result.push({ app: appName, ranges });
  }

  return result;
}

// --- Hilfsfunktionen ---

/**
 * Findet alle .al-Dateien rekursiv in einem Verzeichnis.
 */
export function findAlFiles(dirPath: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...findAlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.al')) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore unreadable dirs */ }
  return results;
}

/**
 * Findet das Ende eines { ... } Blocks.
 * Gibt die Position der schließenden } zurück, oder content.length wenn nicht gefunden.
 */
function findMatchingBrace(content: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < content.length; i++) {
    if (content[i] === '{') {
      depth++;
    } else if (content[i] === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return content.length;
}
