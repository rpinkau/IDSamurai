import * as path from 'path';

export interface AppSource {
  appJson: string;
  srcPath: string;
  /** Absoluter Pfad zum Verzeichnis der config-Datei, um relative Pfade aufzulösen */
  configDir: string;
}

export interface Config {
  orgUrl: string;
  project: string;
  wikiId: string;
  basePath: string;
  appSources: AppSource[];
}

export function validateConfig(raw: Record<string, unknown>, configDir: string): Config {
  const required = ['orgUrl', 'project', 'wikiId', 'basePath', 'appSources'];
  for (const field of required) {
    if (!raw[field]) {
      throw new Error(`Pflichtfeld fehlt in .devops-wiki.json: "${field}"`);
    }
  }

  if (!Array.isArray(raw['appSources']) || (raw['appSources'] as unknown[]).length === 0) {
    throw new Error('.devops-wiki.json: "appSources" muss ein nicht-leeres Array sein');
  }

  const appSources: AppSource[] = (raw['appSources'] as Record<string, unknown>[]).map((src, i) => {
    if (!src['appJson'] || !src['srcPath']) {
      throw new Error(
        `.devops-wiki.json: appSources[${i}] benötigt "appJson" und "srcPath"`
      );
    }
    return {
      appJson: src['appJson'] as string,
      srcPath: src['srcPath'] as string,
      configDir,
    };
  });

  return {
    orgUrl: (raw['orgUrl'] as string).replace(/\/$/, ''), // trailing slash entfernen
    project: raw['project'] as string,
    wikiId: raw['wikiId'] as string,
    basePath: raw['basePath'] as string,
    appSources,
  };
}

/**
 * Löst einen relativen Pfad aus der config auf absoluten Pfad auf.
 */
export function resolvePath(appSource: AppSource, relativePath: string): string {
  return path.resolve(appSource.configDir, relativePath);
}

/**
 * Erstellt den Wiki-URL für eine Seite.
 */
export function buildPageUrl(config: Config, pagePath: string): string {
  const encodedPath = pagePath.split('/').map(encodeURIComponent).join('/');
  return `${config.orgUrl}/${encodeURIComponent(config.project)}/_wiki/wikis/${encodeURIComponent(config.wikiId)}?pagePath=${encodedPath}`;
}
