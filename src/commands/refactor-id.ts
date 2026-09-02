import * as vscode from 'vscode';
import { WikiClient } from '../wiki-client';
import { Config } from '../config';
import { parseObjectHeader, parseObjectsFromConfig } from '../al-parser';

async function isIdAvailable(client: WikiClient, config: Config, type: string, id: number): Promise<boolean> {
  const localObjects = parseObjectsFromConfig(config);
  if (localObjects.some(o => o.type.toLowerCase() === type.toLowerCase() && o.id === id)) {
    return false;
  }
  try {
    const pagePath = `${config.basePath}/${type}-${id}`;
    await client.readPage(pagePath);
    return false; // existiert -> nicht frei
  } catch {
    return true; // 404 -> frei
  }
}

export function registerRefactorIdCommand(
  getClient: () => WikiClient | null,
  getConfig: () => Config | null,
  outputChannel: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.refactorId', async (uri?: vscode.Uri) => {
    let filePath: string;
    
    if (uri) {
      filePath = uri.fsPath;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('IDSamurai: Kein aktiver Editor.');
        return;
      }
      filePath = editor.document.uri.fsPath;
    }

    const config = getConfig();
    const client = getClient();
    if (!config || !client) {
      vscode.window.showErrorMessage('IDSamurai: Konfiguration oder Wiki-Client fehlt.');
      return;
    }

    const objs = parseObjectHeader(filePath, 'Unknown');
    if (!objs || objs.length === 0) {
      vscode.window.showErrorMessage('IDSamurai: Kein gültiges AL-Objekt in dieser Datei gefunden.');
      return;
    }

    const obj = objs[0];
    const oldId = obj.id;
    const objType = obj.type;

    const newIdStr = await vscode.window.showInputBox({
      prompt: `Neue ID für ${objType} ${oldId} eingeben:`,
      validateInput: (val) => {
        if (!/^\d+$/.test(val)) return 'Muss eine Zahl sein';
        return null;
      }
    });

    if (!newIdStr) return;
    const newId = parseInt(newIdStr, 10);
    if (newId === oldId) return;

    // Check if new ID is free
    const isFree = await isIdAvailable(client, config, objType, newId);
    if (!isFree) {
      const confirm = await vscode.window.showWarningMessage(
        `Achtung: Die ID ${newId} ist im Wiki bereits belegt! Trotzdem verwenden?`,
        'Ja', 'Abbrechen'
      );
      if (confirm !== 'Ja') return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const text = document.getText();
    // Regex, die genau die Deklaration matcht: z.B. "table 55000"
    const regex = new RegExp(`^(\\s*${objType}\\s+)${oldId}(\\s+.*)$`, 'im');
    const match = regex.exec(text);
    if (!match) {
      vscode.window.showErrorMessage(`IDSamurai: Konnte die ID im Quellcode nicht finden (erwartet: ${objType} ${oldId}).`);
      return;
    }

    const newText = text.replace(regex, `$1${newId}$2`);
    
    const edit = new vscode.WorkspaceEdit();
    // Replaces the whole document
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length)
    );
    edit.replace(document.uri, fullRange, newText);
    
    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
      // Speichern (löst automatisch den neuen Sync aus!)
      await document.save();
      
      // Alte Wiki-Seite löschen (wenn sie existierte)
      try {
        const pagePath = `${config.basePath}/${objType}-${oldId}`;
        await client.deletePage(pagePath);
        outputChannel.appendLine(`[Refactor] Alte Wiki-Seite ${pagePath} erfolgreich gelöscht.`);
        vscode.window.showInformationMessage(`IDSamurai: Objekt auf ${newId} refaktoriert und Wiki aktualisiert.`);
      } catch (e) {
        outputChannel.appendLine(`[Refactor] Fehler beim Löschen der alten Seite (vielleicht existierte sie noch nicht): ${e}`);
      }
    }
  });
}
