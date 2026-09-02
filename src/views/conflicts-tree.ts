import * as vscode from 'vscode';
import { Config, buildPageUrl } from '../config';
import { WikiClient, WikiPageRef } from '../wiki-client';
import { AlObject, parseObjectsFromConfig } from '../al-parser';
import { parseSubPageName, parseTableFieldsFromWiki } from '../markdown-gen';

type TreeNodeKind =
  | 'root'
  | 'project'
  | 'object-type'
  | 'al-object-conflict'
  | 'al-object-missing'
  | 'al-object-orphaned'
  | 'al-field-conflict'
  | 'loading'
  | 'error';

export class ConflictTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: TreeNodeKind,
    public readonly pageUrl?: string,
    public readonly filePath?: string,
    public readonly children?: ConflictTreeItem[],
    public readonly wikiPath?: string,
  ) {
    super(label, collapsibleState);
    this.contextValue = this.kind;
  }
}

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

export class ConflictsTreeProvider implements vscode.TreeDataProvider<ConflictTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ConflictTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedTree: ConflictTreeItem[] | null = null;
  private isLoading = false;

  constructor(
    private getClient: () => WikiClient | null,
    private getConfig: () => Config | null,
    private outputChannel?: vscode.OutputChannel,
  ) {}

  refresh(): void {
    this.cachedTree = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConflictTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ConflictTreeItem): Promise<ConflictTreeItem[]> {
    if (element?.children) {
      return element.children;
    }
    if (!element) {
      return this.buildRootTree();
    }
    return [];
  }

  private async buildRootTree(): Promise<ConflictTreeItem[]> {
    const config = this.getConfig();
    const client = this.getClient();

    if (!config) {
      return [new ConflictTreeItem('$(warning) Keine .devops-wiki.json', vscode.TreeItemCollapsibleState.None, 'error')];
    }
    if (!client) {
      return [new ConflictTreeItem('$(warning) PAT nicht konfiguriert', vscode.TreeItemCollapsibleState.None, 'error')];
    }

    if (this.cachedTree) {
      return this.cachedTree;
    }

    this.isLoading = true;
    const loadingItem = new ConflictTreeItem('$(loading~spin) Prüfe auf Konflikte…', vscode.TreeItemCollapsibleState.None, 'loading');

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

  private async loadTree(config: Config, client: WikiClient): Promise<ConflictTreeItem[]> {
    let localObjects: AlObject[] = [];
    try {
      localObjects = parseObjectsFromConfig(config);
    } catch { }

    let wikiSubPages: WikiPageRef[] = [];
    try {
      wikiSubPages = await client.listSubPages(config.basePath);
    } catch { }

    const { parseMainPageObjects } = require('../markdown-gen');
    let mainPageObjects: AlObject[] = [];
    try {
      const mainPage = await client.readPage(config.basePath);
      mainPageObjects = parseMainPageObjects(mainPage.content);
    } catch { }

    const objectsByType = new Map<string, Map<number, { local?: AlObject, wikiPath?: string, wikiName?: string, isManual?: boolean, manualName?: string }>>();

    for (const obj of localObjects) {
      const type = obj.type.toLowerCase();
      if (!objectsByType.has(type)) objectsByType.set(type, new Map());
      objectsByType.get(type)!.set(obj.id, { local: obj });
    }

    for (const obj of mainPageObjects) {
      const type = obj.type.toLowerCase();
      if (!objectsByType.has(type)) objectsByType.set(type, new Map());
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

    for (const page of wikiSubPages) {
      const parsed = parseSubPageName(page.path);
      if (parsed) {
        const type = parsed.type;
        if (!objectsByType.has(type)) objectsByType.set(type, new Map());
        const typeMap = objectsByType.get(type)!;
        if (typeMap.has(parsed.id)) {
          typeMap.get(parsed.id)!.wikiPath = page.path;
        } else {
          typeMap.set(parsed.id, { wikiPath: page.path });
        }
      }
    }

    const typeItems: ConflictTreeItem[] = [];
    const typeOrder = [...objectsByType.keys()].sort((a, b) => {
      const la = TYPE_LABELS[a] ?? a;
      const lb = TYPE_LABELS[b] ?? b;
      return la.localeCompare(lb);
    });

    let totalConflictsCount = 0;

    // Wir holen uns die Inhalte aller Sub-Pages, die lokal Tabellenfelder haben, um Feld-Konflikte zu erkennen
    const tableLikeTypes = ['table', 'tableextension'];
    const wikiContentCache = new Map<string, string>();
    for (const l of localObjects) {
      if (tableLikeTypes.includes(l.type.toLowerCase()) && l.fields && l.fields.length > 0) {
        const typeMap = objectsByType.get(l.type.toLowerCase());
        if (typeMap) {
          const entry = typeMap.get(l.id);
          if (entry && entry.wikiPath) {
            try {
              const page = await client.readPage(entry.wikiPath);
              wikiContentCache.set(entry.wikiPath, page.content);
            } catch (e) {
              // ignore
            }
          }
        }
      }
    }

    for (const typeName of typeOrder) {
      const typeMap = objectsByType.get(typeName)!;
      const objectItems: ConflictTreeItem[] = [];

      const idOrder = [...typeMap.keys()].sort((a, b) => a - b);

      for (const id of idOrder) {
        const entry = typeMap.get(id)!;
        
        let isConflict = false;
        let isMissing = false;
        let isOrphaned = false;
        let label = '';
        let tooltip = '';
        let kind: TreeNodeKind | undefined;
        let iconPath: vscode.ThemeIcon | undefined;
        let description = '';
        let command: vscode.Command | undefined;
        let fieldConflictItems: ConflictTreeItem[] = [];

        if (entry.local) {
          const wikiName = entry.wikiName || (entry.isManual ? entry.manualName : undefined);
          
          command = {
            command: 'vscode.open',
            title: 'Öffnen',
            arguments: entry.local.line ? [
              vscode.Uri.file(entry.local.filePath),
              { selection: new vscode.Range(entry.local.line - 1, 0, entry.local.line - 1, 0) }
            ] : [vscode.Uri.file(entry.local.filePath)]
          };

          if (entry.local && entry.local.fields && (typeName === 'table' || typeName === 'tableextension')) {
            const wikiContent = entry.wikiPath ? wikiContentCache.get(entry.wikiPath) : undefined;
            if (wikiContent) {
              const wikiFields = parseTableFieldsFromWiki(wikiContent);
              const wikiFieldsMap = new Map(wikiFields.map(f => [f.id, f.name]));
              
              for (const localF of entry.local.fields) {
                const wikiFName = wikiFieldsMap.get(localF.id);
                if (wikiFName) {
                  const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
                  if (simplify(localF.name) !== simplify(wikiFName)) {
                    const conflictItem = new ConflictTreeItem(
                      `${localF.id} "${localF.name}"`,
                      vscode.TreeItemCollapsibleState.None,
                      'al-object-conflict',
                      undefined,
                      entry.local.filePath,
                      undefined,
                      entry.wikiPath
                    );
                    conflictItem.tooltip = `Feld-Konflikt: Lokal '${localF.name}', im Wiki '${wikiFName}'`;
                    conflictItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
                    conflictItem.description = '(Feld-Konflikt)';
                    fieldConflictItems.push(conflictItem);
                  }
                } else {
                  const missingItem = new ConflictTreeItem(
                    `${localF.id} "${localF.name}"`,
                    vscode.TreeItemCollapsibleState.None,
                    'al-object-missing',
                    undefined,
                    entry.local.filePath,
                    undefined,
                    entry.wikiPath
                  );
                  missingItem.tooltip = `Unregistriert: Feld existiert lokal, aber nicht im Wiki`;
                  missingItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
                  missingItem.description = '(Unregistriertes Feld)';
                  fieldConflictItems.push(missingItem);
                }
              }
              
              // Verwaiste Felder
              const localFieldIds = new Set(entry.local.fields.map(f => f.id));
              for (const wf of wikiFields) {
                if (!localFieldIds.has(wf.id)) {
                  const orphanItem = new ConflictTreeItem(
                    `${wf.id} "${wf.name}"`,
                    vscode.TreeItemCollapsibleState.None,
                    'al-object-orphaned',
                    undefined,
                    entry.local.filePath, // Wir haben keinen Zeilenbezug
                    undefined,
                    entry.wikiPath
                  );
                  orphanItem.tooltip = `Verwaist: Feld existiert im Wiki, aber nicht lokal`;
                  orphanItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
                  orphanItem.description = '(Verwaistes Feld)';
                  fieldConflictItems.push(orphanItem);
                }
              }
            }
          }

          if (wikiName && wikiName !== 'Reservation') {
             const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
             if (simplify(entry.local.name) !== simplify(wikiName)) {
               isConflict = true;
               kind = 'al-object-conflict';
               label = `${id} "${entry.local.name}"`;
               tooltip = `Harter Konflikt: Lokal '${entry.local.name}', im Wiki '${wikiName}'`;
               description = '(Konflikt)';
               iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
             }
          } else if (!entry.wikiPath && !entry.isManual) {
             isMissing = true;
             kind = 'al-object-missing';
             label = `${id} "${entry.local.name}"`;
             tooltip = `Unregistriert: Objekt existiert lokal, aber nicht im Wiki`;
             description = '(Unregistriert)';
             iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
          }
        } else if (entry.wikiPath || entry.isManual) {
          isOrphaned = true;
          kind = 'al-object-orphaned';
          label = `${id} (Im Wiki)${entry.isManual ? ` "${entry.manualName}"` : ''}`;
          tooltip = `Verwaist: Existiert im Wiki, aber keine lokale Datei gefunden`;
          description = '(Verwaist)';
          iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
        }

        if (isConflict || isMissing || isOrphaned || fieldConflictItems.length > 0) {
          const objItem = new ConflictTreeItem(
            label,
            vscode.TreeItemCollapsibleState.None,
            kind!,
            entry.wikiPath ? buildPageUrl(config, entry.wikiPath) : undefined,
            entry.local?.filePath,
            undefined,
            entry.wikiPath
          );
          objItem.tooltip = tooltip;
          objItem.description = description;
          objItem.iconPath = iconPath;
          objItem.command = command;
          
          if (fieldConflictItems.length > 0) {
            // Wir müssen 'children' read/write machen in der Klasse ConflictTreeItem!
            // Da ConflictTreeItem erweitert wurde, können wir stattdessen die Eigenschaft neu setzen:
            (objItem as any).children = fieldConflictItems;
            objItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            totalConflictsCount += fieldConflictItems.length;
            if (!isConflict && !isMissing && !isOrphaned) {
              objItem.iconPath = new vscode.ThemeIcon('symbol-folder'); // Parent obj is fine, but has child issues
            }
          }
          
          objectItems.push(objItem);
          if (isConflict || isMissing || isOrphaned) {
            totalConflictsCount++;
          }
        }
      }

      if (objectItems.length > 0) {
        const typeLabel = TYPE_LABELS[typeName] ?? typeName;
        const groupItem = new ConflictTreeItem(
          `${typeLabel} (${objectItems.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          'object-type',
          undefined,
          undefined,
          objectItems,
        );
        groupItem.iconPath = new vscode.ThemeIcon('symbol-package');
        typeItems.push(groupItem);
      }
    }
    
    if (totalConflictsCount === 0) {
       return [new ConflictTreeItem('Keine Konflikte gefunden ✅', vscode.TreeItemCollapsibleState.None, 'root')];
    }

    const projectRoot = new ConflictTreeItem(
      `${config.project} (Konflikte: ${totalConflictsCount})`,
      vscode.TreeItemCollapsibleState.Expanded,
      'project',
      undefined,
      undefined,
      typeItems,
    );
    projectRoot.iconPath = new vscode.ThemeIcon('repo');

    return [projectRoot];
  }
}
