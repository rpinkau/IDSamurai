import * as vscode from 'vscode';
import * as path from 'path';
import { loadConfig, Config, findGitRoot } from './config';
import { getPat, hasPatSet } from './auth';
import { WikiClient } from './wiki-client';
import { WikiStatusBar } from './status-bar';
import { WikiTreeProvider, RangesTreeProvider } from './views/wiki-tree';
import { createAlCompletionProvider, createAlCodeActionProvider, registerReserveAndInsertIdCommand, registerFieldIdCommands } from './al-completion';
import { registerImportLicenseCommand } from './commands/import-license';
import { registerLmTools } from './lm-tools';
import { registerRangeUsageReportCommand } from './commands/range-usage-report';
import { registerConsumptionReportCommand } from './commands/consumption-report';

import { registerSetPatCommand } from './commands/set-pat';
import { registerOpenPageCommand } from './commands/read-page';
import { registerSyncCommand } from './commands/sync';
import { registerRebuildCommand } from './commands/rebuild';
import { registerDryRunCommand } from './commands/dry-run';
import { registerTestConnectionCommand } from './commands/test-connection';
import { registerNextIdCommand, registerShowRangesCommand, registerReclaimIdCommand, registerBulkReserveCommand, registerResolveConflictLocalCommand, registerResolveConflictWikiCommand } from './commands/id-commands';
import { registerRefactorIdCommand } from './commands/refactor-id';
import { registerCreateConfigCommand } from './commands/create-config';
import { idDiagnosticCollection, refreshDiagnostics, clearDiagnostics } from './diagnostics';

// ──────────────────────────────────────────────────────────
// Extension State
// ──────────────────────────────────────────────────────────

let currentConfig: Config | null = null;
let currentClient: WikiClient | null = null;
let outputChannel: vscode.OutputChannel;
let statusBar: WikiStatusBar;
let treeProvider: WikiTreeProvider;
let rangesProvider: RangesTreeProvider;
let syncQueue: any; // Instantiated below

// Auto-Refresh State
let autoRefreshIntervalHandle: NodeJS.Timeout | null = null;
let lastKnownCommitId: string | null = null;
let lastKnownRepoId: string | null = null;
let mainPageSyncTimeoutHandle: NodeJS.Timeout | null = null;

function getConfig(): Config | null {
  return currentConfig;
}

function getClient(): WikiClient | null {
  return currentClient;
}

async function checkWikiForUpdates() {
  if (!currentClient || !currentConfig) return;
  try {
    if (!lastKnownRepoId) {
      lastKnownRepoId = await currentClient.getWikiRepositoryId();
    }
    if (!lastKnownRepoId) return;

    const commitId = await currentClient.getLatestCommitId(lastKnownRepoId);
    if (!commitId) return;

    if (!lastKnownCommitId) {
      lastKnownCommitId = commitId;
      return;
    }

    if (commitId !== lastKnownCommitId) {
      lastKnownCommitId = commitId;
      // Wiki has changed! Trigger silent refresh.
      treeProvider.refresh();
      rangesProvider.refresh();
      if (vscode.window.activeTextEditor) {
        refreshDiagnostics(vscode.window.activeTextEditor.document, currentConfig, currentClient);
      }
    }
  } catch (e) {
    // Silent fail
  }
}

function startAutoRefreshLoop() {
  if (autoRefreshIntervalHandle) {
    clearInterval(autoRefreshIntervalHandle);
    autoRefreshIntervalHandle = null;
  }
  
  const intervalMinutes = vscode.workspace.getConfiguration('idsamurai').get<number>('autoRefreshInterval', 5);
  if (intervalMinutes > 0) {
    const ms = intervalMinutes * 60 * 1000;
    autoRefreshIntervalHandle = setInterval(() => {
      checkWikiForUpdates();
    }, ms);
    // initial check after 10s to populate lastKnownCommitId
    setTimeout(checkWikiForUpdates, 10000);
  }
}

async function refreshClient(secrets: vscode.SecretStorage): Promise<void> {
  const config = loadConfig();
  currentConfig = config;
  statusBar.setProjectName(config?.project);

  if (!config) {
    currentClient = null;
    statusBar.setState('no-config');
    return;
  }

  const pat = await getPat(secrets);
  if (!pat) {
    currentClient = null;
    statusBar.setState('no-pat');
    outputChannel.appendLine('[INFO] Kein PAT konfiguriert. Bitte "Wiki: PAT konfigurieren" ausführen.');
    return;
  }

  currentClient = new WikiClient(pat, config.orgUrl, config.project, config.wikiId);
  outputChannel.appendLine(`[INFO] Extension aktiviert. Workspace: ${config.project} · Wiki: ${config.wikiId}`);

  // Kein automatischer Verbindungstest mehr auf Startup (wurde vom User als störend empfunden).
  // Stattdessen neutraler Status. Wird erst bei "IDS: Sync" oder "IDS: Verbindungstest" grün.
  statusBar.setState('connected-unverified');
  
  // Falls Offline-Jobs vorhanden sind, versuchen wir diese zu verarbeiten, 
  // das triggert dann auch einen echten Netzwerkkontakt.
  if (syncQueue && syncQueue.getQueueCount() > 0) {
    statusBar.setState('syncing', `Verarbeite ${syncQueue.getQueueCount()} Offline Jobs...`);
    try {
      const { syncSingleFile } = require('./sync-engine');
      await syncQueue.processQueue(config, currentClient, syncSingleFile);
      if (syncQueue.getQueueCount() > 0) {
        statusBar.setState('connection-failed', `Offline: ${syncQueue.getQueueCount()} Jobs in Queue`);
      } else {
        statusBar.setState('ready'); // Jetzt wissen wir sicher, dass es klappt.
      }
    } catch (e) {
      outputChannel.appendLine(`[FEHLER] Offline Queue Verarbeitung fehlgeschlagen: ${e}`);
      statusBar.setState('connection-failed', `Offline: ${syncQueue.getQueueCount()} Jobs in Queue`);
    }
  }

  // Force a tree refresh to clear any stale error messages from previous auth issues
  treeProvider.refresh();
  rangesProvider.refresh();

  startAutoRefreshLoop();
}

// ──────────────────────────────────────────────────────────
// activate()
// ──────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Config laden
  currentConfig = loadConfig();
  
  // LM Tools für GitHub Copilot Chat registrieren
  registerLmTools(context, getConfig, getClient);

  // Output Channel (ein einziger, persistiert über Commands)
  outputChannel = vscode.window.createOutputChannel('IDSamurai');
  context.subscriptions.push(outputChannel);

  // Queue initialisieren
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const { SyncQueue } = require('./sync-queue');
    syncQueue = new SyncQueue(vscode.workspace.workspaceFolders[0].uri.fsPath);
  }

  // Status Bar
  statusBar = new WikiStatusBar();
  context.subscriptions.push(statusBar);

  // Sidebar Views registrieren
  treeProvider = new WikiTreeProvider(getClient, getConfig, outputChannel);
  const treeView = vscode.window.createTreeView('ids.pages', {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(treeView);

  rangesProvider = new RangesTreeProvider(getClient, getConfig, outputChannel);
  const rangesView = vscode.window.createTreeView('ids.ranges', {
    treeDataProvider: rangesProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(rangesView);

  // Client initialisieren
  await refreshClient(context.secrets);

  // Callback nach erfolgreicher Sync-Operation
  const onSyncComplete = (changes: number = 0): void => {
    const now = new Date();
    statusBar.setLastSync(now, changes);
    treeProvider.refresh();
    rangesProvider.refresh();
  };

  // ── Commands registrieren ──

  context.subscriptions.push(
    registerSetPatCommand(context),
  );

  // Nach PAT-Änderung: Client neu erstellen
  context.subscriptions.push(
    vscode.commands.registerCommand('ids._refreshClient', async () => {
      await refreshClient(context.secrets);
      treeProvider.refresh();
      rangesProvider.refresh();
    })
  );

  // SecretStorage Change → Client neu erstellen
  context.secrets.onDidChange(async (e) => {
    if (e.key === 'ids.pat') {
      await refreshClient(context.secrets);
      treeProvider.refresh();
      rangesProvider.refresh();
    }
  });

  context.subscriptions.push(
    registerOpenPageCommand(getClient, getConfig),
    registerSyncCommand(getClient, getConfig, outputChannel, onSyncComplete),
    registerTestConnectionCommand(getClient, getConfig, outputChannel, () => {
      statusBar.setState('ready');
      treeProvider.refresh();
      rangesProvider.refresh();
    }),
    registerRebuildCommand(getClient, getConfig, outputChannel, onSyncComplete),
    registerDryRunCommand(getClient, getConfig, outputChannel),
    registerNextIdCommand(getClient, getConfig, outputChannel),
    registerShowRangesCommand(getConfig, outputChannel),
    registerRefactorIdCommand(getClient, getConfig, outputChannel),
    registerReclaimIdCommand(getClient, outputChannel, () => {
      treeProvider.refresh();
      rangesProvider.refresh();
    }),
    registerBulkReserveCommand(getConfig, getClient, outputChannel, () => {
      treeProvider.refresh();
      rangesProvider.refresh();
    }),
    registerResolveConflictLocalCommand(() => {
      treeProvider.refresh();
      rangesProvider.refresh();
    }),
    registerResolveConflictWikiCommand(() => {
      treeProvider.refresh();
      rangesProvider.refresh();
    }),
    registerCreateConfigCommand(),
    registerReserveAndInsertIdCommand(getClient, getConfig, outputChannel),
    registerImportLicenseCommand(getClient, getConfig, outputChannel, onSyncComplete),
    registerRangeUsageReportCommand(getConfig, getClient, outputChannel),
    registerConsumptionReportCommand(getConfig, getClient, outputChannel),
    ...registerFieldIdCommands(outputChannel)
  );

  // Tree Refresh Command
  context.subscriptions.push(
    vscode.commands.registerCommand('ids.refreshTree', () => {
      treeProvider.refresh();
      rangesProvider.refresh();
    }),
    vscode.commands.registerCommand('ids.openWikiUrl', (item: any) => {
      if (item && item.pageUrl) {
        vscode.env.openExternal(vscode.Uri.parse(item.pageUrl));
      }
    })
  );

  // ── Diagnostics (Live-Linter) ──
  if (vscode.window.activeTextEditor) {
    refreshDiagnostics(vscode.window.activeTextEditor.document, currentConfig, currentClient);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        refreshDiagnostics(editor.document, currentConfig, currentClient);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      refreshDiagnostics(event.document, currentConfig, currentClient);
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      clearDiagnostics(doc);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('idsamurai.autoRefreshInterval')) {
        startAutoRefreshLoop();
      }
    })
  );

  context.subscriptions.push(idDiagnosticCollection);

  // ── CompletionProvider für AL-Dateien (Phase 5) ──
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'al' },
      createAlCompletionProvider(getConfig, getClient, outputChannel, (msg) => {
        statusBar.setState('connection-failed', msg);
      }),
      ' ', '(', // Trigger nach Space oder Klammer
    )
  );

  // ── CodeActionProvider (Quick Fix / Alt+Enter) für AL-Dateien ──
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'al' },
      createAlCodeActionProvider(getConfig, getClient, outputChannel, (msg) => {
        statusBar.setState('connection-failed', msg);
      }),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  // ── Auto-Sync on Save & Smart Cleanup ──
  const alWatcher = vscode.workspace.createFileSystemWatcher('**/*.al');
  
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.languageId === 'al' && currentConfig && currentClient) {
        try {
          const { updateFileInCache } = require('./al-parser');
          updateFileInCache(doc.uri.fsPath, currentConfig);
          const { syncSingleFile, syncMainPage } = require('./sync-engine');
          await syncSingleFile(doc.uri.fsPath, currentConfig, currentClient);
          treeProvider.refresh();
          rangesProvider.refresh();
          
          // Debounced update der Hauptseite (30s)
          if (mainPageSyncTimeoutHandle) {
            clearTimeout(mainPageSyncTimeoutHandle);
          }
          mainPageSyncTimeoutHandle = setTimeout(async () => {
            try {
              if (currentConfig && currentClient) {
                outputChannel.appendLine(`[Auto-Sync] Hauptseite aktualisieren (debounced)...`);
                await syncMainPage(currentConfig, currentClient);
                outputChannel.appendLine(`[Auto-Sync] Hauptseite erfolgreich aktualisiert.`);
              }
            } catch (err) {
              outputChannel.appendLine(`[Fehler] Auto-Sync Hauptseite fehlgeschlagen: ${err}`);
            }
          }, 30000);

        } catch (e: any) {
          const { isNetworkError } = require('./sync-queue');
          if (isNetworkError(e)) {
            syncQueue?.addJob(doc.uri.fsPath);
            statusBar.setState('connection-failed', `Offline: ${syncQueue.getQueueCount()} Jobs in Queue`);
            outputChannel.appendLine(`[Offline] Sync für ${doc.uri.fsPath} in Warteschlange eingereiht (Netzwerkfehler).`);
          } else {
            outputChannel.appendLine(`[Fehler] Auto-Sync fehlgeschlagen für ${doc.uri.fsPath}: ${e}`);
          }
        }
      }
    }),
    alWatcher.onDidDelete(async uri => {
      if (!currentConfig || !currentClient) return;
      
      const { parsedObjectsCache, updateFileInCache } = require('./al-parser');
      const cachedObjs = parsedObjectsCache.get(uri.fsPath);
      updateFileInCache(uri.fsPath, currentConfig); // Removes it from cache
      
      if (cachedObjs && cachedObjs.length > 0) {
        for (const cachedObj of cachedObjs) {
          const type = cachedObj.type;
          const id = cachedObj.id;
          const wikiPath = `${currentConfig.basePath}/${type}-${id}`;
          try {
            // Check if it exists in wiki
            const pages = await currentClient.listSubPages(currentConfig.basePath);
            const exists = pages.some(p => p.path === wikiPath || p.path.startsWith(wikiPath + ' '));
            
            if (exists) {
              const answer = await vscode.window.showInformationMessage(
                `IDSamurai: Du hast das lokale Objekt '${type} ${id}' gelöscht. Soll die Reservierung im Wiki freigegeben werden?`,
                'Ja, freigeben', 'Ignorieren'
              );
              
              if (answer === 'Ja, freigeben') {
                // Finde den exakten Pfad (falls er einen Branch-Namen enthält)
                const exactPage = pages.find(p => p.path === wikiPath || p.path.startsWith(wikiPath + ' '));
                if (exactPage) {
                  await currentClient.deletePage(exactPage.path);
                  outputChannel.appendLine(`[Smart Cleanup] Seite gelöscht: ${exactPage.path}`);
                  treeProvider.refresh();
                  rangesProvider.refresh();
                }
              }
            }
          } catch (e) {
            outputChannel.appendLine(`[Fehler] Smart Cleanup fehlgeschlagen: ${e}`);
          }
        }
      }
    }),
    alWatcher
  );

  // ── Workspace-Config-Watcher ──
  // Hilfsfunktion zum Binden der Watcher-Events
  const bindWatcher = (w: vscode.FileSystemWatcher) => {
    w.onDidChange(async () => {
      outputChannel.appendLine('[INFO] .devops-wiki.json geändert — Konfiguration neu laden…');
      await refreshClient(context.secrets);
      treeProvider.refresh();
    });
    w.onDidCreate(async () => {
      outputChannel.appendLine('[INFO] .devops-wiki.json erstellt — Extension aktivieren…');
      await refreshClient(context.secrets);
      treeProvider.refresh();
    });
    w.onDidDelete(() => {
      outputChannel.appendLine('[INFO] .devops-wiki.json gelöscht — Extension deaktiviert.');
      currentConfig = null;
      currentClient = null;
      statusBar.setState('no-config');
      treeProvider.refresh();
    });
    context.subscriptions.push(w);
  };

  // 1. Watcher für alle eindeutigen Git-Roots
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const gitRoots = new Set<string>();
    for (const folder of workspaceFolders) {
      const gitRoot = findGitRoot(folder.uri.fsPath);
      if (gitRoot) {
        gitRoots.add(gitRoot);
      }
    }

    for (const root of gitRoots) {
      const gitConfigWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, '.devops-wiki.json'),
        false, false, false
      );
      bindWatcher(gitConfigWatcher);
    }
  }

  outputChannel.appendLine('[INFO] IDSamurai Extension geladen.');
}

// ──────────────────────────────────────────────────────────
// deactivate()
// ──────────────────────────────────────────────────────────

export function deactivate(): void {
  // VS Code räumt Subscriptions automatisch auf
}
