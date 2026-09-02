import * as https from 'https';
import * as http from 'http';

export interface WikiPage {
  id: number;
  path: string;
  content: string;
  etag: string;
}

export interface WikiPageRef {
  id: number;
  path: string;
}

export class WikiClient {
  private readonly baseUrl: string;

  constructor(
    private pat: string,
    private orgUrl: string,
    private project: string,
    private wikiId: string,
  ) {
    const encodedProject = encodeURIComponent(project);
    const encodedWikiId = encodeURIComponent(wikiId);
    this.baseUrl = `${orgUrl}/${encodedProject}/_apis/wiki/wikis/${encodedWikiId}/pages`;
  }

  // Basic-Auth Header für ADO: Base64(":PAT")
  private get authHeader(): string {
    const b64 = Buffer.from(`:${this.pat}`).toString('base64');
    return `Basic ${b64}`;
  }

  /**
   * Liest eine Wiki-Seite und gibt Content + ETag zurück.
   * Wirft einen Fehler wenn die Seite nicht existiert (404).
   */
  async readPage(pagePath: string): Promise<WikiPage> {
    const url = `${this.baseUrl}?path=${encodeURIComponent(pagePath)}&includeContent=true&api-version=7.1`;
    const response = await this.request('GET', url);

    if (response.status === 404) {
      throw new Error(`Seite nicht gefunden: ${pagePath}`);
    }
    if (response.status !== 200) {
      throw new Error(`readPage fehlgeschlagen (${response.status}) für URL: ${url}\nResponse: ${response.body}`);
    }

    const data = JSON.parse(response.body);
    return {
      id: data.id,
      path: data.path,
      content: data.content ?? '',
      etag: response.etag ?? '',
    };
  }

  /**
   * Erstellt oder aktualisiert eine Wiki-Seite.
   * ACHTUNG: Bei einem 412 (Konflikt) wird der übergebene Inhalt blind erzwungen.
   * Für sichere Updates mit Read-Modify-Write bitte `updatePage` verwenden.
   */
  async writePage(pagePath: string, content: string): Promise<void> {
    const url = `${this.baseUrl}?path=${encodeURIComponent(pagePath)}&api-version=7.1`;

    // Versuche ETag zu holen (Seite könnte bereits existieren)
    let etag: string | undefined;
    try {
      const existing = await this.readPage(pagePath);
      etag = existing.etag;
    } catch {
      // Seite existiert nicht → PUT ohne ETag (Create)
      etag = undefined;
    }

    const body = JSON.stringify({ content });
    const extraHeaders: Record<string, string> = {};
    if (etag) {
      extraHeaders['If-Match'] = etag;
    }

    let response = await this.request('PUT', url, body, extraHeaders);

    // 412 = ETag veraltet → einmal neu holen und Retry
    if (response.status === 412) {
      try {
        const refreshed = await this.readPage(pagePath);
        extraHeaders['If-Match'] = refreshed.etag;
      } catch {
        // ignore
      }
      response = await this.request('PUT', url, body, extraHeaders);
    }

    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`writePage fehlgeschlagen (${response.status}) für URL: ${url}\nResponse: ${response.body}`);
    }
  }

  /**
   * Liest, modifiziert und schreibt eine Wiki-Seite sicher.
   * Wenn ein ETag-Konflikt (412) auftritt, wird neu gelesen und der Prozess wiederholt (max Retries).
   */
  async updatePage(pagePath: string, updater: (currentContent: string) => string): Promise<void> {
    let retries = 5;
    while (retries > 0) {
      retries--;
      let currentContent = '';
      let etag: string | undefined;
      
      try {
        const page = await this.readPage(pagePath);
        currentContent = page.content;
        etag = page.etag;
      } catch (e) {
        // Seite existiert nicht
      }
      
      const newContent = updater(currentContent);
      if (newContent === currentContent) return; // Nichts zu tun
      
      const success = await this.writePageStrict(pagePath, newContent, etag);
      if (success) {
        return;
      }
      // Wenn nicht success (412), dann nächste Runde
    }
    throw new Error(`Konnte Seite nicht aktualisieren: Zu viele Konflikte (412) für URL: ${pagePath}`);
  }

  /**
   * Holt die versteckte Repository-ID des Wikis.
   */
  async getWikiRepositoryId(): Promise<string | null> {
    const encodedProject = encodeURIComponent(this.project);
    let wikiIdentifier = encodeURIComponent(this.wikiId);
    
    // Fallback falls wikiId noch der Name ist, aber wir brauchen die ID für DevOps APIs manchmal
    const url = `${this.orgUrl}/${encodedProject}/_apis/wiki/wikis/${wikiIdentifier}?api-version=7.1`;
    try {
      const response = await this.request('GET', url);
      if (response.status === 200) {
        const data = JSON.parse(response.body);
        return data.repositoryId || null;
      }
    } catch {
      // Ignorieren
    }
    return null;
  }

  /**
   * Holt den aktuellsten Git-Commit Hash für eine Repository-ID.
   */
  async getLatestCommitId(repositoryId: string): Promise<string | null> {
    const encodedProject = encodeURIComponent(this.project);
    const url = `${this.orgUrl}/${encodedProject}/_apis/git/repositories/${repositoryId}/commits?searchCriteria.$top=1&api-version=7.1`;
    try {
      const response = await this.request('GET', url);
      if (response.status === 200) {
        const data = JSON.parse(response.body);
        if (data.value && data.value.length > 0) {
          return data.value[0].commitId || null;
        }
      }
    } catch {
      // Ignorieren
    }
    return null;
  }

  /**
   * Schreibt eine Seite mit einem strikten ETag (oder ohne für Erstellung).
   * Gibt `true` zurück bei Erfolg (200/201).
   * Gibt `false` zurück bei einem ETag-Konflikt (412).
   */
  async writePageStrict(pagePath: string, content: string, etag?: string): Promise<boolean> {
    const url = `${this.baseUrl}?path=${encodeURIComponent(pagePath)}&api-version=7.1`;
    const body = JSON.stringify({ content });
    const extraHeaders: Record<string, string> = {};
    if (etag) {
      extraHeaders['If-Match'] = etag;
    }

    const response = await this.request('PUT', url, body, extraHeaders);

    if (response.status === 412) {
      return false;
    }

    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`writePageStrict fehlgeschlagen (${response.status}) für URL: ${url}\nResponse: ${response.body}`);
    }

    return true;
  }

  /**
   * Löscht eine Wiki-Seite.
   */
  async deletePage(pagePath: string): Promise<void> {
    const url = `${this.baseUrl}?path=${encodeURIComponent(pagePath)}&api-version=7.1`;
    const response = await this.request('DELETE', url);

    if (response.status !== 200 && response.status !== 204) {
      throw new Error(`deletePage fehlgeschlagen (${response.status}) für URL: ${url}\nResponse: ${response.body}`);
    }
  }

  /**
   * Listet alle direkten Sub-Pages eines Parent-Pfades auf (recursionLevel=oneLevel).
   */
  async listSubPages(parentPath: string): Promise<WikiPageRef[]> {
    const url = `${this.baseUrl}?path=${encodeURIComponent(parentPath)}&recursionLevel=oneLevel&api-version=7.1`;
    const response = await this.request('GET', url);

    if (response.status === 404) {
      return [];
    }
    if (response.status !== 200) {
      throw new Error(`listSubPages fehlgeschlagen (${response.status}) für URL: ${url}\nResponse: ${response.body}`);
    }

    const data = JSON.parse(response.body);
    return (data.subPages ?? []) as WikiPageRef[];
  }

  /**
   * Führt einen HTTP-Request aus. Unterstützt GET, PUT, DELETE.
   * Handled 429 Rate-Limiting mit exponentiellem Backoff.
   */
  private async request(
    method: string,
    url: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
    retryCount = 0,
  ): Promise<{ status: number; body: string; etag?: string }> {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers: Record<string, string> = {
      'Authorization': this.authHeader,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };

    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }

    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
      };

      const req = lib.request(options, (res: http.IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', async () => {
          const status = res.statusCode ?? 0;
          const etag = res.headers['etag'] as string | undefined;

          // Rate limit: warte und retry
          if (status === 429 && retryCount < 5) {
            const delay = Math.pow(2, retryCount) * 500;
            await sleep(delay);
            try {
              const retried = await this.request(method, url, body, extraHeaders, retryCount + 1);
              resolve(retried);
            } catch (e) {
              reject(e);
            }
            return;
          }

          resolve({ status, body: data, etag });
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
