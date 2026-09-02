import * as vscode from 'vscode';

export type StatusBarState = 
  | 'ready' 
  | 'syncing' 
  | 'no-pat' 
  | 'no-config' 
  | 'error' 
  | 'out-of-sync' 
  | 'connection-failed'
  | 'connected-unverified';

export class WikiStatusBar {
  private readonly item: vscode.StatusBarItem;
  private projectName: string = 'Wiki';

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      10,
    );
    this.item.command = 'workbench.action.quickOpen';
    this.item.name = 'IDSamurai';
    this.setState('no-config');
    this.item.show();
  }

  setProjectName(name: string | undefined): void {
    this.projectName = name || 'Wiki';
  }

  setState(state: StatusBarState, detail?: string): void {
    switch (state) {
      case 'ready':
        this.item.text = `$(book) ${this.projectName}`;
        this.item.tooltip = detail ?? 'IDSamurai — Klick für Commands';
        this.item.backgroundColor = undefined;
        this.item.color = new vscode.ThemeColor('testing.iconPassed'); // Grüner Text
        this.item.command = 'workbench.action.quickOpen';
        break;

      case 'syncing':
        this.item.text = `$(loading~spin) ${this.projectName}: Sync…`;
        this.item.tooltip = detail ?? 'IDSamurai läuft…';
        this.item.backgroundColor = undefined;
        this.item.color = undefined;
        break;

      case 'no-pat':
        this.item.text = `$(warning) Wiki: Kein PAT`;
        this.item.tooltip = 'IDSamurai: PAT nicht konfiguriert. Klick → "Wiki: PAT konfigurieren"';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.color = undefined;
        this.item.command = 'ids.setPat';
        break;

      case 'no-config':
        this.item.text = `$(warning) Wiki nicht verbunden`;
        this.item.tooltip = 'IDSamurai: Keine .devops-wiki.json im Workspace';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.color = undefined;
        break;

      case 'out-of-sync':
        this.item.text = `$(warning) ${this.projectName}: out of sync`;
        this.item.tooltip = detail ?? 'IDS: Änderungen seit letztem Sync erkannt';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.color = undefined;
        this.item.command = 'ids.sync';
        break;

      case 'connected-unverified':
        this.item.text = `$(globe) ${this.projectName}`;
        this.item.tooltip = 'IDS: Bereit (Verbindung noch nicht geprüft). Klick für Commands';
        this.item.backgroundColor = undefined;
        this.item.color = undefined; // Kein Grün, neutrale Textfarbe
        this.item.command = 'workbench.action.quickOpen';
        break;

      case 'connection-failed':
        this.item.text = `$(warning) ${this.projectName}`;
        this.item.tooltip = detail ?? 'Verbindungstest fehlgeschlagen (Gelb)';
        this.item.backgroundColor = undefined;
        this.item.color = new vscode.ThemeColor('charts.yellow');
        this.item.command = 'ids.testConnection';
        break;

      case 'error':
        this.item.text = `$(error) ${this.projectName}: Fehler`;
        this.item.tooltip = detail ?? 'IDSamurai: Fehler — Details im Output Channel';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.item.color = undefined;
        this.item.command = 'workbench.action.quickOpen';
        break;
    }
  }

  setLastSync(time: Date, changes: number): void {
    const timeStr = time.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const changesStr = changes === 0 ? '0 Änderungen' : `${changes} Änderungen`;
    this.item.text = `$(book) ${this.projectName}`;
    this.item.tooltip = `IDSamurai — Letzte Sync: ${timeStr} (${changesStr})`;
    this.item.backgroundColor = undefined;
    this.item.color = new vscode.ThemeColor('testing.iconPassed');
    this.item.command = 'workbench.action.quickOpen';
  }

  dispose(): void {
    this.item.dispose();
  }
}
