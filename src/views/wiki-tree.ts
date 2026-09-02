import * as vscode from 'vscode';
import { Config, buildPageUrl } from '../config';
import { WikiClient, WikiPageRef } from '../wiki-client';
import { AlObject, parseObjectsFromConfig, parseRanges, AppRanges } from '../al-parser';
import { getRangeStats, RangeStats } from '../id-manager';
import { parseSubPageName } from '../markdown-gen';

// ──────────────────────────────────────────────────────────
// Tree-Item Typen
// ──────────────────────────────────────────────────────────

type TreeNodeKind =
  | 'root'
  | 'project'
  | 'object-type'
  | 'al-object'
  | 'al-field'
  | 'loading'
  | 'error'
  | 'range-group';

export class WikiTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: TreeNodeKind,
    public readonly pageUrl?: string,
    public readonly filePath?: string,
    public readonly children?: WikiTreeItem[],
    public readonly wikiPath?: string,
  ) {
    super(label, collapsibleState);
    if (this.kind === 'al-object' && this.wikiPath && !this.filePath) {
      this.contextValue = 'al-object-reclaimable';
    } else {
      this.contextValue = this.kind;
    }
  }
}

// ──────────────────────────────────────────────────────────
// TreeDataProvider
// ──────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  codeunit:        'Codeunits',
  enum:            'Enums',
  enumextension:   'Enum Extensions',
  page:            'Pages',
  pageextension:   'Page Extensions',
  permissionset:   'Permission Sets',
  query:           'Queries',
  report:          'Reports',
  reportextension: 'Report Extensions',
  table:           'Tables',
  tableextension:  'Table Extensions',
  xmlport:         'XMLports',
};

export class WikiTreeProvider implements vscode.TreeDataProvider<WikiTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WikiTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedTree: WikiTreeItem[] | null = null;
  private isLoading = false;

  constructor(
    private getClient: () => WikiClient | null,
    private getConfig: () => Config | null,
    private outputChannel?: vscode.OutputChannel,
  ) {}

  refresh(): void {
    if (this.isLoading) return;
    this.cachedTree = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WikiTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WikiTreeItem): Promise<WikiTreeItem[]> {
    // Child-Nodes direkt zurückgeben wenn vorhanden
    if (element?.children) {
      return element.children;
    }

    // Root-Ebene
    if (!element) {
      return this.buildRootTree();
    }

    return [];
  }

  private async buildRootTree(): Promise<WikiTreeItem[]> {
    const config = this.getConfig();
    const client = this.getClient();

    if (!config) {
      const item = new WikiTreeItem(
        '$(warning) Keine .devops-wiki.json gefunden',
        vscode.TreeItemCollapsibleState.None,
        'error',
      );
      return [item];
    }

    if (!client) {
      const item = new WikiTreeItem(
        '$(warning) PAT nicht konfiguriert',
        vscode.TreeItemCollapsibleState.None,
        'error',
      );
      return [item];
    }

    if (this.cachedTree) {
      return this.cachedTree;
    }

    this.isLoading = true;
    const loadingItem = new WikiTreeItem(
      '$(loading~spin) Lade AL-Objekte & Wiki…',
      vscode.TreeItemCollapsibleState.None,
      'loading',
    );

    // Async laden
    this.loadTree(config, client).then(tree => {
      this.cachedTree = tree;
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
    }).catch(() => {
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
    });

    return [loadingItem];
  }

  private async loadTree(config: Config, client: WikiClient): Promise<WikiTreeItem[]> {
    // 1. Lokale Objekte parsen
    let localObjects: AlObject[] = [];
    try {
      localObjects = parseObjectsFromConfig(config);
    } catch {
      // ignore
    }

    // 2. Wiki Seiten abfragen
    let wikiSubPages: WikiPageRef[] = [];
    try {
      wikiSubPages = await client.listSubPages(config.basePath);
    } catch {
      // ignore
    }

    // 2.5 Hauptseite parsen für manuelle Einträge (z.B. Codeunits)
    const { parseMainPageObjects } = require('../markdown-gen');
    let mainPageObjects: AlObject[] = [];
    try {
      const mainPage = await client.readPage(config.basePath);
      mainPageObjects = parseMainPageObjects(mainPage.content);
    } catch {
      // ignore
    }

    // 3. Mergen (Lokal + Wiki)
    const objectsByType = new Map<string, Map<number, { local?: AlObject, wikiPath?: string, wikiName?: string, isManual?: boolean, manualName?: string }>>();

    // Lokale einordnen
    for (const obj of localObjects) {
      const type = obj.type.toLowerCase();
      if (!objectsByType.has(type)) {
        objectsByType.set(type, new Map());
      }
      objectsByType.get(type)!.set(obj.id, { local: obj });
    }

    // Manuelle Wiki-Einträge aus der Hauptseite einordnen
    for (const obj of mainPageObjects) {
      const type = obj.type.toLowerCase();
      if (!objectsByType.has(type)) {
        objectsByType.set(type, new Map());
      }
      const typeMap = objectsByType.get(type)!;
      if (!typeMap.has(obj.id)) {
        typeMap.set(obj.id, { isManual: true, manualName: obj.name, wikiName: obj.name });
      } else {
        const existing = typeMap.get(obj.id)!;
        existing.isManual = true;
        existing.manualName = obj.name;
        existing.wikiName = obj.name;
      }
    }

    // Wiki Seiten einordnen
    for (const page of wikiSubPages) {
      const parsed = parseSubPageName(page.path);
      if (parsed) {
        const type = parsed.type;
        if (!objectsByType.has(type)) {
          objectsByType.set(type, new Map());
        }
        const typeMap = objectsByType.get(type)!;
        if (typeMap.has(parsed.id)) {
          typeMap.get(parsed.id)!.wikiPath = page.path;
        } else {
          typeMap.set(parsed.id, { wikiPath: page.path });
        }
      }
    }

    // 4. Baum aufbauen
    const typeItems: WikiTreeItem[] = [];

    // Typ-Gruppen alphabetisch sortieren
    const typeOrder = [...objectsByType.keys()].sort((a, b) => {
      const la = TYPE_LABELS[a] ?? a;
      const lb = TYPE_LABELS[b] ?? b;
      return la.localeCompare(lb);
    });

    for (const typeName of typeOrder) {
      const typeMap = objectsByType.get(typeName)!;
      const objectItems: WikiTreeItem[] = [];
      let groupHasWarning = false;

      // Objekte nach ID sortieren
      const idOrder = [...typeMap.keys()].sort((a, b) => a - b);

      for (const id of idOrder) {
        const entry = typeMap.get(id)!;
        
        let label = '';
        let tooltip = '';
        let isYellow = false;
        let isRed = false;
        let isConflict = false;
        let command: vscode.Command | undefined;
        let fieldItems: WikiTreeItem[] = [];

        if (entry.local) {
          // Normales lokales Objekt
          label = `${id} "${entry.local.name}"`;
          tooltip = entry.local.filePath;
          
          // Conflict Detection
          const wikiName = entry.wikiName || (entry.isManual ? entry.manualName : undefined);
          if (wikiName && wikiName !== 'Reservation') {
             // Simplify names for comparison to avoid false positives on small changes (e.g. whitespace)
             const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
             if (simplify(entry.local.name) !== simplify(wikiName)) {
               isConflict = true;
               isRed = true;
               tooltip = `⚠️ Konflikt: Lokal '${entry.local.name}', im Wiki '${wikiName}'`;
             }
          }

          command = {
            command: 'vscode.open',
            title: 'Öffnen',
            arguments: entry.local.line ? [
              vscode.Uri.file(entry.local.filePath),
              { selection: new vscode.Range(entry.local.line - 1, 0, entry.local.line - 1, 0) }
            ] : [
              vscode.Uri.file(entry.local.filePath)
            ]
          };

          // Wenn Felder vorhanden sind (bei Tables)
          if (entry.local.fields && entry.local.fields.length > 0) {
            fieldItems = entry.local.fields
              .sort((a, b) => a.id - b.id)
              .map(f => {
                const fItem = new WikiTreeItem(
                  `${f.id} "${f.name}"`,
                  vscode.TreeItemCollapsibleState.None,
                  'al-field',
                );
                fItem.iconPath = new vscode.ThemeIcon('symbol-field');
                fItem.command = {
                  command: 'vscode.open',
                  title: 'Öffnen',
                  arguments: f.line ? [
                    vscode.Uri.file(entry.local!.filePath),
                    { selection: new vscode.Range(f.line - 1, 0, f.line - 1, 0) }
                  ] : [
                    vscode.Uri.file(entry.local!.filePath)
                  ]
                };
                return fItem;
              });
          }

          // Wenn Page-Felder vorhanden sind (bei Pages)
          if (entry.local.pageFields && entry.local.pageFields.length > 0) {
            fieldItems = entry.local.pageFields
              .map(f => {
                const fItem = new WikiTreeItem(
                  `"${f.caption}" (${f.sourceExpression})`,
                  vscode.TreeItemCollapsibleState.None,
                  'al-field',
                );
                fItem.iconPath = new vscode.ThemeIcon('symbol-field');
                fItem.command = {
                  command: 'vscode.open',
                  title: 'Öffnen',
                  arguments: f.line ? [
                    vscode.Uri.file(entry.local!.filePath),
                    { selection: new vscode.Range(f.line - 1, 0, f.line - 1, 0) }
                  ] : [
                    vscode.Uri.file(entry.local!.filePath)
                  ]
                };
                return fItem;
              });
          }
        } else if (entry.wikiPath || entry.isManual) {
          // Nur im Wiki! Gelb machen!
          label = `${id} (Im Wiki)${entry.isManual ? ` "${entry.manualName}"` : ''}`;
          tooltip = 'Existiert nur im Wiki, nicht lokal!';
          isYellow = true;
          
          if (entry.wikiPath) {
            const pageUrl = buildPageUrl(config, entry.wikiPath);
            command = undefined; // Do not open browser on row click
          } else {
            const pageUrl = buildPageUrl(config, config.basePath);
            command = undefined; // Do not open browser on row click
          }
        }

        const objItem = new WikiTreeItem(
          label,
          fieldItems.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          'al-object',
          entry.wikiPath ? buildPageUrl(config, entry.wikiPath) : undefined,
          entry.local?.filePath,
          fieldItems.length > 0 ? fieldItems : undefined,
          entry.wikiPath
        );

        if (isConflict) {
          objItem.contextValue = 'al-object-conflict';
        }

        if (isRed) {
          objItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
          if (isConflict) objItem.description = '(Konflikt)';
        } else if (isYellow) {
          objItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
          objItem.description = '(Im Wiki)';
        } else {
          objItem.iconPath = new vscode.ThemeIcon('file');
        }
        
        objItem.command = command;
        objItem.tooltip = tooltip;
        objectItems.push(objItem);
        
        if (isYellow || isRed) {
          groupHasWarning = true;
        }
      }

      const label = TYPE_LABELS[typeName] ?? typeName;
      const groupItem = new WikiTreeItem(
        `${label} (${objectItems.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        'object-type',
        undefined,
        undefined,
        objectItems,
      );
      if (groupHasWarning) {
        groupItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      } else {
        groupItem.iconPath = new vscode.ThemeIcon('symbol-package');
      }
      typeItems.push(groupItem);
    }
    
    const projectHasWarning = typeItems.some(t => (t.iconPath as vscode.ThemeIcon).id === 'warning');

    const projectRoot = new WikiTreeItem(
      config.project,
      vscode.TreeItemCollapsibleState.Expanded,
      'project',
      undefined,
      undefined,
      typeItems,
    );
    if (projectHasWarning) {
      projectRoot.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    } else {
      projectRoot.iconPath = new vscode.ThemeIcon('repo');
    }

    return [projectRoot];
  }
}

// ──────────────────────────────────────────────────────────
// RangesTreeProvider
// ──────────────────────────────────────────────────────────

export class RangesTreeProvider implements vscode.TreeDataProvider<WikiTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WikiTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedTree: WikiTreeItem[] | null = null;
  private isLoading = false;

  constructor(
    private getClient: () => WikiClient | null,
    private getConfig: () => Config | null,
    private outputChannel?: vscode.OutputChannel,
  ) {}

  refresh(): void {
    if (this.isLoading) return;
    this.cachedTree = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WikiTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WikiTreeItem): Promise<WikiTreeItem[]> {
    if (element?.children) {
      return element.children;
    }

    if (!element) {
      return this.buildRootTree();
    }

    return [];
  }

  private async buildRootTree(): Promise<WikiTreeItem[]> {
    const config = this.getConfig();
    const client = this.getClient();

    if (!config || !client) {
      return [];
    }

    if (this.cachedTree) {
      return this.cachedTree;
    }

    this.isLoading = true;
    const loadingItem = new WikiTreeItem(
      '$(loading~spin) Lade Ranges…',
      vscode.TreeItemCollapsibleState.None,
      'loading',
    );

    this.loadRanges(config, client).then(tree => {
      this.cachedTree = tree;
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
    }).catch(() => {
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
    });

    return [loadingItem];
  }

  private async loadRanges(config: Config, client: WikiClient): Promise<WikiTreeItem[]> {
    let localObjects: AlObject[] = [];
    try {
      localObjects = parseObjectsFromConfig(config);
    } catch {
      // ignore
    }

    const { getRangeStatsWithWiki } = require('../id-manager');
    const appRanges = parseRanges(config);
    const rangeStatsItems: WikiTreeItem[] = [];
    
    try {
      const stats = await getRangeStatsWithWiki(localObjects, appRanges, client, config, this.outputChannel);
      
      if (stats.length === 0 && this.outputChannel) {
        this.outputChannel.appendLine(`[Ranges] Keine Ranges gefunden. Bitte prüfe die Wiki-Seite ${config.basePath} auf die Tabelle "ID-Ranges (freie Bereiche)".`);
      }

      const LICENSED_TYPES = ['table', 'page', 'codeunit', 'report', 'xmlport', 'query'];
      
      // Group by description -> type -> ranges
      const groups = new Map<string, Map<string, {
        stats: RangeStats[],
        totalFree: number,
        totalCap: number,
        isLicensed: boolean
      }>>();

      for (const stat of stats) {
        let desc = stat.range.description?.trim() || 'Ohne Name';
        // Falls [ und ] im Namen sind (z.B. "[IDSamurai]"), entfernen wir sie nicht zwingend, 
        // aber der User bat darum: "Dort steht allerdings eckige Klammer auf, eckige Klammer zu... Das kann weg."
        // Also bereinigen wir typische Präfixe, falls vorhanden:
        desc = desc.replace(/^\[.*?\]\s*/, '').trim();

        const typeLabel = TYPE_LABELS[stat.type] ?? stat.type;
        const isLicensed = LICENSED_TYPES.includes(stat.type);
        
        if (!groups.has(desc)) {
          groups.set(desc, new Map());
        }
        const typeMap = groups.get(desc)!;
        
        if (!typeMap.has(typeLabel)) {
          typeMap.set(typeLabel, { stats: [], totalFree: 0, totalCap: 0, isLicensed });
        }
        
        const typeGroup = typeMap.get(typeLabel)!;
        typeGroup.stats.push(stat);
        typeGroup.totalFree += stat.freeCount;
        typeGroup.totalCap += (stat.range.to - stat.range.from + 1);
      }

      // Convert groups to parent tree items
      const sortedGroupKeys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
      for (const groupName of sortedGroupKeys) {
        const typeMap = groups.get(groupName)!;
        const typeItems: WikiTreeItem[] = [];
        let groupHasWarning = false;

        const sortedTypeKeys = Array.from(typeMap.keys()).sort((a, b) => {
          // Sortieren: Zuerst lizenzierte, dann unlizenzierte, dann alphabetisch
          const aLic = typeMap.get(a)!.isLicensed;
          const bLic = typeMap.get(b)!.isLicensed;
          if (aLic && !bLic) return -1;
          if (!aLic && bLic) return 1;
          return a.localeCompare(b);
        });

        for (const typeLabel of sortedTypeKeys) {
          const typeGroup = typeMap.get(typeLabel)!;
          const leafItems: WikiTreeItem[] = [];
          let typeHasWarning = typeGroup.totalFree < 10;
          
          for (const stat of typeGroup.stats) {
             let leafLabel = `${stat.range.from}..${stat.range.to} (${stat.freeCount} frei)`;
             const leafItem = new WikiTreeItem(
                typeGroup.isLicensed ? leafLabel : '',
                vscode.TreeItemCollapsibleState.None,
                'object-type'
             );
             if (!typeGroup.isLicensed) {
                leafItem.description = `${leafLabel} - ${stat.app}`;
             } else {
                leafItem.description = stat.app;
             }

             if (stat.freeCount < 10) {
               leafItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
             } else {
               leafItem.iconPath = new vscode.ThemeIcon(typeGroup.isLicensed ? 'info' : 'symbol-misc');
             }
             leafItems.push(leafItem);
          }

          if (typeHasWarning) groupHasWarning = true;

          const typeParentItem = new WikiTreeItem(
             `${typeLabel} (${typeGroup.totalFree} frei von ${typeGroup.totalCap})`,
             vscode.TreeItemCollapsibleState.Expanded,
             'range-group',
             undefined,
             undefined,
             leafItems
          );
          typeParentItem.iconPath = new vscode.ThemeIcon(
             typeHasWarning ? 'error' : (typeGroup.isLicensed ? 'symbol-class' : 'symbol-misc'),
             typeHasWarning ? new vscode.ThemeColor('errorForeground') : undefined
          );
          typeItems.push(typeParentItem);
        }

        const groupItem = new WikiTreeItem(
          groupName, // <--- KEIN "Name: " Präfix mehr!
          vscode.TreeItemCollapsibleState.Expanded,
          'range-group',
          undefined,
          undefined,
          typeItems
        );
        groupItem.iconPath = new vscode.ThemeIcon(
          groupHasWarning ? 'warning' : 'symbol-array',
          groupHasWarning ? new vscode.ThemeColor('charts.yellow') : undefined
        );
        rangeStatsItems.push(groupItem);
      }
    } catch (e: any) {
      if (this.outputChannel) {
        this.outputChannel.appendLine(`[Ranges] Fehler beim Laden der Ranges: ${e.message}`);
      }
    }

    return rangeStatsItems;
  }
}
