import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { AppSource, Config, validateConfig, resolvePath, buildPageUrl } from './config-core';
export { AppSource, Config, resolvePath, buildPageUrl };


/**
 * Sucht ausgehend von einem Start-Pfad den übergeordneten Ordner, der das `.git` Verzeichnis enthält.
 */
export function findGitRoot(startPath: string): string | null {
  let current = startPath;
  while (current) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Sucht die .devops-wiki.json ausgehend von einem Startpfad aufwärts
 * durch alle Elternverzeichnisse bis zum Laufwerksroot.
 */
function findConfigUpwards(startPath: string): string | null {
  let current = startPath;
  while (current) {
    const configPath = path.join(current, '.devops-wiki.json');
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Sucht und lädt die .devops-wiki.json im Workspace.
 * Suchkette: 1. Git-Root, 2. Workspace-Folder direkt, 3. Aufwärtssuche vom Folder.
 * Gibt null zurück wenn keine gefunden wurde.
 */
export function loadConfig(): Config | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return null;
  }

  // Sammle alle Config-Pfade (dedupliziert)
  const foundConfigPaths = new Set<string>();

  for (const folder of workspaceFolders) {
    const folderPath = folder.uri.fsPath;

    // Strategie 1: Git-Root (Rückwärtskompatibilität)
    const gitRoot = findGitRoot(folderPath);
    if (gitRoot) {
      const configInGitRoot = path.join(gitRoot, '.devops-wiki.json');
      if (fs.existsSync(configInGitRoot)) {
        foundConfigPaths.add(path.normalize(configInGitRoot));
        continue; // Git-Root hat Priorität, kein weiterer Fallback nötig
      }
    }

    // Strategie 2+3: Aufwärtssuche ab Workspace-Folder (deckt auch den Folder selbst ab)
    const configUpwards = findConfigUpwards(folderPath);
    if (configUpwards) {
      foundConfigPaths.add(path.normalize(configUpwards));
    }
  }

  // Lade alle gefundenen Configs
  const configs: Config[] = [];
  for (const configPath of foundConfigPaths) {
    const configDir = path.dirname(configPath);
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const config = validateConfig(parsed, configDir);
      configs.push(config);
    } catch (e) {
      vscode.window.showErrorMessage(
        `IDSamurai: Fehler beim Lesen der .devops-wiki.json in ${configDir}: ${e}`
      );
      return null;
    }
  }

  if (configs.length === 0) {
    return null;
  }

  // 3. Prüfen ob sie alle dasselbe Wiki referenzieren
  const first = configs[0];
  for (let i = 1; i < configs.length; i++) {
    const current = configs[i];
    if (current.orgUrl !== first.orgUrl || 
        current.project !== first.project || 
        current.wikiId !== first.wikiId) {
      vscode.window.showErrorMessage(
        'IDSamurai: Mehrere unterschiedliche Wikis im Workspace gefunden. Dies wird nicht unterstützt.'
      );
      return null;
    }
  }

  // 4. Merge AppSources and dynamically discover multi-root apps
  const mergedConfig = { ...first };
  const allAppSources = configs.flatMap(c => c.appSources);
  
  mergedConfig.appSources = [];
  const appJsonSet = new Set<string>();

  // Füge zuerst die manuell konfigurierten hinzu
  for (const src of allAppSources) {
    const absPath = path.normalize(resolvePath(src, src.appJson)).toLowerCase();
    if (!appJsonSet.has(absPath)) {
      appJsonSet.add(absPath);
      mergedConfig.appSources.push(src);
    }
  }

  // Scanne zusätzlich alle VS Code Workspace Folders automatisch (für Multi-Root)
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const absAppJson = path.normalize(path.join(folder.uri.fsPath, 'app.json'));
    const lowerAppJson = absAppJson.toLowerCase();
    
    if (fs.existsSync(absAppJson) && !appJsonSet.has(lowerAppJson)) {
      appJsonSet.add(lowerAppJson);
      
      const hasSrcDir = fs.existsSync(path.join(folder.uri.fsPath, 'src'));
      mergedConfig.appSources.push({
        configDir: folder.uri.fsPath,
        appJson: 'app.json',
        srcPath: hasSrcDir ? 'src' : '.'
      });
    }
  }

  return mergedConfig;
}
