import * as vscode from 'vscode';
import { setPat } from '../auth';

export function registerSetPatCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand('ids.setPat', async () => {
    await setPat(context.secrets);
  });
}
