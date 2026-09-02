import * as cp from 'child_process';
import { Config } from './config';

export function getCurrentGitBranch(config: Config, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!config.basePath || !cwd) {
      resolve(null);
      return;
    }

    cp.exec('git rev-parse --abbrev-ref HEAD', { cwd }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}
