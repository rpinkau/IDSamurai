import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { findGitRoot } from '../config';

export function registerCreateConfigCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('ids.createConfigTemplate', async () => {
    const activeEditor = vscode.window.activeTextEditor;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let targetDir: string | null = null;

    if (activeEditor) {
      targetDir = findGitRoot(activeEditor.document.uri.fsPath);
    }

    if (!targetDir && workspaceFolders && workspaceFolders.length > 0) {
      targetDir = findGitRoot(workspaceFolders[0].uri.fsPath);
    }

    if (!targetDir) {
      vscode.window.showErrorMessage('IDSamurai: Es konnte kein übergeordnetes Git-Repository (.git) gefunden werden, um die Konfiguration zu speichern.');
      return;
    }

    const configPath = path.join(targetDir, '.devops-wiki.json');

    if (fs.existsSync(configPath)) {
      vscode.window.showInformationMessage('IDSamurai: Die Datei .devops-wiki.json existiert bereits.');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
      await vscode.window.showTextDocument(doc);
      return;
    }

    // Suche nach app.json Dateien im targetDir
    const pattern = new vscode.RelativePattern(targetDir, '**/app.json');
    const appJsonUris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
    
    const appSources = [];
    if (appJsonUris.length > 0) {
      for (const uri of appJsonUris) {
        // Relativer Pfad zur app.json, basierend auf targetDir
        const relativeAppJson = path.relative(targetDir, uri.fsPath).replace(/\\/g, '/');
        // Relativer Pfad zum Ordner
        const relativeFolder = path.dirname(relativeAppJson);
        
        // Prüfen, ob es in diesem Ordner ein src-Verzeichnis gibt
        const srcPathAbs = path.join(path.dirname(uri.fsPath), 'src');
        const hasSrc = fs.existsSync(srcPathAbs);
        
        const srcPath = hasSrc 
          ? (relativeFolder === '.' ? 'src' : `${relativeFolder}/src`) 
          : (relativeFolder === '.' ? '.' : relativeFolder);
          
        appSources.push({
          appJson: relativeAppJson,
          srcPath: srcPath
        });
      }
    } else {
      // Fallback
      appSources.push({
        appJson: "app.json",
        srcPath: "src",
        objIdConfig: null
      });
    }

    const template = {
      orgUrl: "https://dev.azure.com/YourOrganization",
      project: "YourProjectName",
      wikiId: "YourWikiName",
      basePath: "/",
      appSources: appSources
    };

    try {
      fs.writeFileSync(configPath, JSON.stringify(template, null, 2), 'utf8');
      vscode.window.showInformationMessage('IDSamurai: Vorlage .devops-wiki.json erstellt.');
      
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
      await vscode.window.showTextDocument(doc);
    } catch (e) {
      vscode.window.showErrorMessage(`IDSamurai: Fehler beim Erstellen der Datei: ${e}`);
    }
  });
}
