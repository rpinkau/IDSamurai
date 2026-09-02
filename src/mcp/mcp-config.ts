import * as fs from 'fs';
import * as path from 'path';

import { AppSource, Config, validateConfig } from '../config-core';
export { AppSource, Config };

export function loadConfigFromDir(workspaceDir: string): Config {
  // Ähnliche Suche wie im Haupt-Config.ts (aufwärts)
  let current = workspaceDir;
  let configPath = null;
  
  while (current) {
    const cp = path.join(current, '.devops-wiki.json');
    if (fs.existsSync(cp)) {
      configPath = cp;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (!configPath) {
    throw new Error(`Keine .devops-wiki.json in ${workspaceDir} oder Elternverzeichnissen gefunden.`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const configDir = path.dirname(configPath);
  
  return validateConfig(parsed, configDir);
}


