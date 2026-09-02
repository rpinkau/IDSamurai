import * as vscode from 'vscode';

const SECRET_KEY = 'ids.pat';

/**
 * Liest den gespeicherten PAT aus dem VS Code SecretStorage (OS-Keychain).
 */
export async function getPat(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return secrets.get(SECRET_KEY);
}

/**
 * Fordert den User auf, seinen ADO PAT einzugeben, und speichert ihn im SecretStorage.
 */
export async function setPat(secrets: vscode.SecretStorage): Promise<void> {
  const pat = await vscode.window.showInputBox({
    prompt: 'IDSamurai: Azure DevOps PAT eingeben (Scope: Wiki Read & Write)',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  });
  if (pat && pat.trim().length > 0) {
    await secrets.store(SECRET_KEY, pat.trim());
    vscode.window.showInformationMessage('IDSamurai: PAT erfolgreich gespeichert.');
  }
}

/**
 * Löscht den gespeicherten PAT.
 */
export async function clearPat(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(SECRET_KEY);
}

/**
 * Prüft ob ein PAT gesetzt ist.
 */
export async function hasPatSet(secrets: vscode.SecretStorage): Promise<boolean> {
  const pat = await secrets.get(SECRET_KEY);
  return !!pat && pat.trim().length > 0;
}
