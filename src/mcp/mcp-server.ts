#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadConfigFromDir, Config } from "./mcp-config";
import { WikiClient } from "../wiki-client";
import { parseObjectsFromConfig, parseRanges, parseObjectHeader } from "../al-parser";
import { reserveId, getRangeStatsWithWiki } from "../id-manager";
import { findConsecutiveFreeBlock } from "./mcp-tools";
import { getSubPagePath, parseSubPageName } from "../markdown-gen";
import * as fs from 'fs';
import * as path from 'path';

const mcpLogger = {
  appendLine: (val: string) => {
    console.error(`[IDSamurai] ${val}`);
  }
};

async function main() {
  const args = process.argv.slice(2);
  const workspaceDir = args[0] || process.cwd();

  const pat = process.env.ADO_PAT || process.env.IDSAMURAI_PAT;
  if (!pat) {
    console.error("Fehler: ADO_PAT oder IDSAMURAI_PAT Umgebungsvariable muss gesetzt sein.");
    process.exit(1);
  }

  let config: Config;
  try {
    config = loadConfigFromDir(workspaceDir);
  } catch (e: any) {
    console.error(`Konfigurationsfehler: ${e.message}`);
    process.exit(1);
  }

  const client = new WikiClient(pat, config.orgUrl, config.project, config.wikiId);
  
  let mcpVersion = "1.9.4";
  try {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.version) mcpVersion = pkg.version;
    } else {
      const fallbackPkgPath = path.resolve(__dirname, "../package.json");
      if (fs.existsSync(fallbackPkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(fallbackPkgPath, "utf-8"));
        if (pkg.version) mcpVersion = pkg.version;
      }
    }
  } catch (e) {}

  const server = new Server(
    { name: "idsamurai-mcp", version: mcpVersion },
    { capabilities: { tools: {} } }
  );

  const tools: Tool[] = [
    {
      name: "reserve_new_id",
      description: "Reserviert die nächste freie ID für ein AL-Objekt im Azure DevOps Wiki.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string" }, name: { type: "string" } },
        required: ["type"],
      },
    },
    {
      name: "reserve_id_batch",
      description: "Reserviert mehrere IDs auf einmal, optional als zusammenhängenden Block. Maximal 20 IDs pro Aufruf.",
      inputSchema: {
        type: "object",
        properties: {
          requests: { type: "array", items: { type: "object", properties: { type: { type: "string" }, count: { type: "number" }, consecutive: { type: "boolean" } } } },
          feature_name: { type: "string" }
        },
        required: ["requests"],
      },
    },
    {
      name: "reclaim_id",
      description: "Gibt eine reservierte ID im Wiki wieder frei.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string" }, id: { type: "number" } },
        required: ["type", "id"],
      },
    },
    {
      name: "check_id_status",
      description: "Prüft, ob eine bestimmte ID frei oder belegt ist.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string" }, id: { type: "number" } },
        required: ["type", "id"],
      },
    },
    {
      name: "get_range_stats",
      description: "Gibt Statistiken zu belegten und freien IDs pro Objekttyp zurück.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_objects",
      description: "Listet alle bekannten AL-Objekte (lokal + Wiki) eines bestimmten Typs auf.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string" } },
      },
    },
    {
      name: "get_object_info",
      description: "Gibt detaillierte Informationen über ein spezifisches lokales Objekt zurück (z.B. Felder).",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string" }, id: { type: "number" } },
        required: ["type", "id"],
      },
    },
    {
      name: "validate_al_file",
      description: "Prüft eine AL-Datei auf ID-Konflikte und Range-Verletzungen.",
      inputSchema: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
    },
    {
      name: "read_wiki_page",
      description: "Liest den Inhalt einer Wiki-Seite (z.B. für Objekt-Dokumentationen).",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string" }, id: { type: "number" } },
        required: ["type", "id"],
      },
    }
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // In-memory Cache für AL Objekte, um Disk-I/O zu sparen
  let cachedObjects: any[] | null = null;
  let cachedRanges: any[] | null = null;
  let cacheTimestamp = 0;
  const CACHE_TTL_MS = 5000; // 5 Sekunden

  function getCachedLocalData() {
    const now = Date.now();
    if (!cachedObjects || !cachedRanges || (now - cacheTimestamp > CACHE_TTL_MS)) {
      cachedObjects = parseObjectsFromConfig(config);
      cachedRanges = parseRanges(config);
      cacheTimestamp = now;
    }
    // Wichtig: Kopien zurückgeben
    return {
      objects: [...cachedObjects],
      appRanges: JSON.parse(JSON.stringify(cachedRanges))
    };
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    
    try {
      const { objects, appRanges } = getCachedLocalData();

      if (name === "reserve_new_id") {
        const type = String(args.type);
        const featureName = args.name ? String(args.name) : undefined;
        const suggestion = await reserveId(type, objects, appRanges, client, config, undefined, undefined, featureName);
        if (!suggestion) {
          const validTypes = Array.from(new Set(appRanges.flatMap((ar: any) => Object.keys(ar.ranges)))).join(", ");
          throw new Error(`Keine freie ID für '${type}' gefunden. Gültige konfigurierte Typen: ${validTypes}`);
        }
        return { content: [{ type: "text", text: JSON.stringify({ id: suggestion.nextFreeId, type: suggestion.type, status: "reserved" }) }] };
      }

      if (name === "reserve_id_batch") {
        const requests = args.requests as any[];
        const feature = args.feature_name ? String(args.feature_name) : "AI Batch Reservation";
        const results: Record<string, number[]> = {};
        
        let totalCount = 0;
        for (const req of requests) totalCount += (Number(req.count) || 1);
        if (totalCount > 20) {
          throw new Error("Maximal 20 IDs pro Batch-Aufruf erlaubt.");
        }

        // Caching for Wiki
        let cachedWikiSubPages: any[] = [];
        try { cachedWikiSubPages = await client.listSubPages(config.basePath); } catch (e) {}

        for (const req of requests) {
          const type = String(req.type).toLowerCase();
          const count = Number(req.count) || 1;
          const consecutive = Boolean(req.consecutive);
          results[type] = results[type] || [];

          if (consecutive && count > 1) {
            const block = await findConsecutiveFreeBlock(type, count, objects, appRanges, client, config);
            if (!block) {
              const validTypes = Array.from(new Set(appRanges.flatMap((ar: any) => Object.keys(ar.ranges)))).join(", ");
              throw new Error(`Kein zusammenhängender Block von ${count} IDs für '${type}' gefunden. Gültige Typen: ${validTypes}`);
            }
            
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
                    if (checkPage.content.includes(`LOCK: ${lockId}`)) {
                      success = true;
                    }
                  } catch (e) {}
                }
              }
              if (!success) {
                throw new Error(`Fehler bei Lock-Verifizierung für ID ${id} im Consecutive-Block.`);
              }
              results[type].push(id);
              objects.push({ type, id, name: 'Reservation', filePath: '', app: '' });
              cachedWikiSubPages.push({ path: getSubPagePath(config.basePath, { type, id, name: '', filePath: '', app: '' }), url: '' });
            }
          } else {
            for (let i = 0; i < count; i++) {
              const suggestion = await reserveId(type, objects, appRanges, client, config, cachedWikiSubPages, undefined, feature);
              if (!suggestion) {
                const validTypes = Array.from(new Set(appRanges.flatMap((ar: any) => Object.keys(ar.ranges)))).join(", ");
                throw new Error(`Ranges für "${type}" sind nach ${i} Reservierungen voll! Gültige Typen: ${validTypes}`);
              }
              results[type].push(suggestion.nextFreeId);
              objects.push({ type, id: suggestion.nextFreeId, name: 'Reservation', filePath: '', app: suggestion.app });
              cachedWikiSubPages.push({ path: getSubPagePath(config.basePath, suggestion as any), url: '' });
            }
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({ reservations: results, feature_name: feature }) }] };
      }

      if (name === "reclaim_id") {
        const type = String(args.type).toLowerCase();
        const id = Number(args.id);
        const pagePath = getSubPagePath(config.basePath, { type, id, name: '', filePath: '', app: '' });
        
        let page;
        try {
          page = await client.readPage(pagePath);
        } catch (e) {
          throw new Error(`Wiki-Seite nicht gefunden oder Fehler beim Lesen: ${pagePath}`);
        }
        
        if (!page.content.includes("<!-- IDSAMURAI_RESERVATION:")) {
          throw new Error("Diese Seite scheint keine ungenutzte Reservierung zu sein. Löschen verweigert.");
        }

        await client.deletePage(pagePath);
        return { content: [{ type: "text", text: JSON.stringify({ status: "released", message: `ID ${id} für ${type} wurde im Wiki freigegeben.` }) }] };
      }

      if (name === "check_id_status") {
        const type = String(args.type).toLowerCase();
        const id = Number(args.id);
        const localObject = objects.find(o => o.type.toLowerCase() === type && o.id === id);
        
        let wikiReserved = false;
        try {
          const pagePath = getSubPagePath(config.basePath, { type, id, name: '', filePath: '', app: '' });
          await client.readPage(pagePath);
          wikiReserved = true;
        } catch { wikiReserved = false; }

        return { content: [{ type: "text", text: JSON.stringify({ is_free: !localObject && !wikiReserved, local_object: localObject || null, wiki_reserved: wikiReserved }) }] };
      }

      if (name === "get_range_stats") {
        const stats = await getRangeStatsWithWiki(objects, appRanges, client, config, mcpLogger);
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
      }

      if (name === "list_objects") {
        const typeFilter = args.type ? String(args.type).toLowerCase() : null;
        const res = objects.filter(o => !typeFilter || o.type.toLowerCase() === typeFilter);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      if (name === "get_object_info") {
        const type = String(args.type).toLowerCase();
        const id = Number(args.id);
        const localObject = objects.find(o => o.type.toLowerCase() === type && o.id === id);
        if (!localObject) throw new Error("Objekt nicht lokal gefunden.");
        
        const headers = parseObjectHeader(localObject.filePath, localObject.app);
        return { content: [{ type: "text", text: JSON.stringify((headers && headers.length > 0) ? headers[0] : localObject, null, 2) }] };
      }

      if (name === "validate_al_file") {
        const filePath = String(args.file_path);
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(path.resolve(workspaceDir))) {
          throw new Error(`Zugriff verweigert: Pfad liegt außerhalb des Workspaces (${filePath})`);
        }
        
        if (!fs.existsSync(resolvedPath)) throw new Error(`Datei nicht gefunden: ${resolvedPath}`);
        
        const fileObjects = parseObjectHeader(resolvedPath, "Unknown") || [];
        const issues: any[] = [];
        
        for (const obj of fileObjects) {
          // Check collision
          const collision = objects.find(o => o.type.toLowerCase() === obj.type.toLowerCase() && o.id === obj.id && o.filePath !== resolvedPath);
          if (collision) {
            issues.push({ severity: "error", message: `ID ${obj.id} ist bereits durch '${collision.name}' in '${collision.filePath}' belegt.` });
          }
          // Check range
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
            issues.push({ severity: "warning", message: `ID ${obj.id} liegt außerhalb der konfigurierten Ranges für ${obj.type}.` });
          }
        }
        
        return { content: [{ type: "text", text: JSON.stringify({ valid: issues.length === 0, issues }, null, 2) }] };
      }

      if (name === "read_wiki_page") {
        const type = String(args.type).toLowerCase();
        const id = Number(args.id);
        const pagePath = getSubPagePath(config.basePath, { type, id, name: '', filePath: '', app: '' });
        
        try {
          const page = await client.readPage(pagePath);
          return { content: [{ type: "text", text: page.content }] };
        } catch (e) {
          throw new Error(`Wiki-Seite nicht gefunden oder Fehler beim Lesen: ${pagePath}`);
        }
      }

      throw new Error(`Tool nicht implementiert: ${name}`);
    } catch (e: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLogger.appendLine("MCP Server gestartet auf stdio.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
