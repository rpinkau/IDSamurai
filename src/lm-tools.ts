import * as vscode from 'vscode';
import * as fs from 'fs';
import { reserveId, getRangeStatsWithWiki } from './id-manager';
import { findConsecutiveFreeBlock } from './mcp/mcp-tools';
import { Config } from './config-core';
import { WikiClient } from './wiki-client';
import { parseObjectsFromConfig, parseRanges, parseObjectHeader } from './al-parser';
import { getSubPagePath } from './markdown-gen';

export function registerLmTools(
  context: vscode.ExtensionContext, 
  getConfig: () => Config | null,
  getClient: () => WikiClient | null
) {
  if (typeof vscode.lm === 'undefined' || !vscode.lm.registerTool) return;

  const mcpLogger = { appendLine: (val: string) => console.log(val) };

  function getCore() {
    const config = getConfig();
    const client = getClient();
    if (!config || !client) throw new Error('IDSamurai ist nicht konfiguriert (PAT fehlt).');
    const objects = parseObjectsFromConfig(config);
    const appRanges = parseRanges(config);
    return { config, client, objects, appRanges };
  }

  // 1. Reserve ID
  context.subscriptions.push(vscode.lm.registerTool('reserveId', {
    prepareInvocation: async (options) => {
      const input = options.input as any;
      return { invocationMessage: `Reserviere ${input.type} ID für ${input.name}...` };
    },
    invoke: async (options, token) => {
      try {
        const { config, client, objects, appRanges } = getCore();
        const input = options.input as any;
        const suggestion = await reserveId(input.type, objects, appRanges, client, config, undefined, undefined, input.name);
        if (!suggestion) throw new Error('Keine freie ID gefunden.');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({ id: suggestion.nextFreeId, type: suggestion.type, status: 'reserved' }))
        ]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));

  // 2. Reserve Batch
  context.subscriptions.push(vscode.lm.registerTool('reserveIdBatch', {
    prepareInvocation: async (options) => ({ invocationMessage: 'Reserviere mehrere IDs...' }),
    invoke: async (options, token) => {
      try {
        const { config, client, objects, appRanges } = getCore();
        const input = options.input as any;
        const requests = input.requests || [];
        const feature = input.feature_name || 'AI Batch Reservation';
        const results: Record<string, number[]> = {};
        
        let cachedWikiSubPages: any[] = [];
        try { cachedWikiSubPages = await client.listSubPages(config.basePath); } catch (e) {}

        for (const req of requests) {
          const type = String(req.type).toLowerCase();
          const count = Number(req.count) || 1;
          const consecutive = Boolean(req.consecutive);
          results[type] = results[type] || [];

          if (consecutive && count > 1) {
            const block = await findConsecutiveFreeBlock(type, count, objects, appRanges, client, config);
            if (!block) throw new Error(`Kein zusammenhängender Block von ${count} IDs für ${type} gefunden.`);
            
            for (const id of block) {
              let success = false;
              let retries = 5;
              while (retries > 0 && !success) {
                retries--;
                const now = new Date().toISOString();
                const lockId = Math.random().toString(36).substring(2, 15);
                const content = `> ⏳ Diese ID wurde am ${now} für "${feature}" reserviert.\n\n<!-- IDSAMURAI_RESERVATION: ${now} LOCK: ${lockId} -->`;
                const pagePath = getSubPagePath(config.basePath, { type, id, name: 'Reservation', filePath: '', app: '' });
                const wrote = await client.writePageStrict(pagePath, content, undefined);
                if (wrote) {
                  try {
                    const checkPage = await client.readPage(pagePath);
                    if (checkPage.content.includes(`LOCK: ${lockId}`)) success = true;
                  } catch (e) {}
                }
              }
              if (!success) throw new Error(`Fehler bei Lock-Verifizierung für ID ${id}`);
              results[type].push(id);
              objects.push({ type, id, name: 'Reservation', filePath: '', app: '' });
              cachedWikiSubPages.push({ path: getSubPagePath(config.basePath, { type, id, name: '', filePath: '', app: '' }), url: '' });
            }
          } else {
            for (let i = 0; i < count; i++) {
              const suggestion = await reserveId(type, objects, appRanges, client, config, cachedWikiSubPages, undefined, feature);
              if (!suggestion) throw new Error(`Ranges für ${type} sind voll!`);
              results[type].push(suggestion.nextFreeId);
              objects.push({ type, id: suggestion.nextFreeId, name: 'Reservation', filePath: '', app: suggestion.app });
              cachedWikiSubPages.push({ path: getSubPagePath(config.basePath, suggestion as any), url: '' });
            }
          }
        }
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify({ reservations: results, feature_name: feature }))
        ]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));

  // 3. Reclaim ID
  context.subscriptions.push(vscode.lm.registerTool('reclaimId', {
    prepareInvocation: async (options) => ({ invocationMessage: 'Gebe ID frei...' }),
    invoke: async (options, token) => {
      try {
        const { config, client } = getCore();
        const input = options.input as any;
        const type = String(input.type).toLowerCase();
        const id = Number(input.id);
        const pagePath = getSubPagePath(config.basePath, { type, id, name: '', filePath: '', app: '' });
        
        let page;
        try { page = await client.readPage(pagePath); } catch (e) { throw new Error('Wiki-Seite nicht gefunden.'); }
        if (!page.content.includes('<!-- IDSAMURAI_RESERVATION:')) throw new Error('Diese Seite scheint keine ungenutzte Reservierung zu sein.');

        await client.deletePage(pagePath);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ status: 'released' }))]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));

  // 4. Check Status
  context.subscriptions.push(vscode.lm.registerTool('checkIdStatus', {
    prepareInvocation: async (options) => ({ invocationMessage: 'Prüfe ID Status...' }),
    invoke: async (options, token) => {
      try {
        const { config, client, objects } = getCore();
        const input = options.input as any;
        const type = String(input.type).toLowerCase();
        const id = Number(input.id);
        const localObject = objects.find(o => o.type.toLowerCase() === type && o.id === id);
        
        let wikiReserved = false;
        try {
          const pagePath = getSubPagePath(config.basePath, { type, id, name: '', filePath: '', app: '' });
          await client.readPage(pagePath);
          wikiReserved = true;
        } catch { wikiReserved = false; }

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ is_free: !localObject && !wikiReserved, local_object: localObject || null, wiki_reserved: wikiReserved }))]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));

  // 5. Range Stats
  context.subscriptions.push(vscode.lm.registerTool('getRangeStats', {
    prepareInvocation: async (options) => ({ invocationMessage: 'Lade Range Stats...' }),
    invoke: async (options, token) => {
      try {
        const { config, client, objects, appRanges } = getCore();
        const stats = await getRangeStatsWithWiki(objects, appRanges, client, config, mcpLogger);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(stats, null, 2))]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));

  // 6. List Objects
  context.subscriptions.push(vscode.lm.registerTool('listObjects', {
    prepareInvocation: async (options) => ({ invocationMessage: 'Lade AL Objekte...' }),
    invoke: async (options, token) => {
      try {
        const { objects } = getCore();
        const input = options.input as any;
        const typeFilter = input.type ? String(input.type).toLowerCase() : null;
        const res = objects.filter(o => !typeFilter || o.type.toLowerCase() === typeFilter);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(res, null, 2))]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));

  // 7. Get Info
  context.subscriptions.push(vscode.lm.registerTool('getObjectInfo', {
    prepareInvocation: async (options) => ({ invocationMessage: 'Lade Objekt Info...' }),
    invoke: async (options, token) => {
      try {
        const { objects } = getCore();
        const input = options.input as any;
        const type = String(input.type).toLowerCase();
        const id = Number(input.id);
        const localObject = objects.find(o => o.type.toLowerCase() === type && o.id === id);
        if (!localObject) throw new Error('Objekt nicht lokal gefunden.');
        
        const headers = parseObjectHeader(localObject.filePath, localObject.app);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify((headers && headers.length > 0) ? headers[0] : localObject, null, 2))]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));

  // 8. Validate File
  context.subscriptions.push(vscode.lm.registerTool('validateAlFile', {
    prepareInvocation: async (options) => ({ invocationMessage: 'Validiere AL Datei...' }),
    invoke: async (options, token) => {
      try {
        const { objects, appRanges } = getCore();
        const input = options.input as any;
        const filePath = String(input.file_path);
        
        if (!fs.existsSync(filePath)) throw new Error(`Datei nicht gefunden: ${filePath}`);
        
        const fileObjects = parseObjectHeader(filePath, 'Unknown') || [];
        const issues: any[] = [];
        
        for (const obj of fileObjects) {
          const collision = objects.find(o => o.type.toLowerCase() === obj.type.toLowerCase() && o.id === obj.id && o.filePath !== filePath);
          if (collision) {
            issues.push({ severity: 'error', message: `ID ${obj.id} ist bereits durch '${collision.name}' belegt.` });
          }
          let inRange = false;
          for (const ar of appRanges) {
            const ranges = ar.ranges[obj.type.toLowerCase()];
            if (ranges) {
              for (const r of ranges) {
                if (obj.id >= r.from && obj.id <= r.to) {
                  inRange = true;
                  break;
                }
              }
            }
          }
          if (!inRange && appRanges.length > 0) {
            issues.push({ severity: 'warning', message: `ID ${obj.id} liegt außerhalb der Ranges.` });
          }
        }
        
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ valid: issues.length === 0, issues }, null, 2))]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));

  // 9. Read Wiki Page
  context.subscriptions.push(vscode.lm.registerTool('readWikiPage', {
    prepareInvocation: async (options) => ({ invocationMessage: 'Lese Wiki Seite...' }),
    invoke: async (options, token) => {
      try {
        const { config, client } = getCore();
        const input = options.input as any;
        const type = String(input.type).toLowerCase();
        const id = Number(input.id);
        const pagePath = getSubPagePath(config.basePath, { type, id, name: '', filePath: '', app: '' });
        
        const page = await client.readPage(pagePath);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(page.content)]);
      } catch (err: any) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ error: err.message }))]);
      }
    }
  }));
}
