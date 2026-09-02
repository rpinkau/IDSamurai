# Plan: ADO Wiki Sync – VS Code Extension

## Implementierungs-Briefing

**Dein Auftrag**: Baue eine VS Code Extension (`ado-wiki-sync`), die Azure DevOps Wiki-Seiten für Business Central AL-Projekte automatisch generiert und synchronisiert. Die Extension bietet Commands, eine Sidebar-Tree-View, Status-Bar-Integration und optionale Auto-Sync-Erkennung.

**Was ist Business Central AL?** Eine Programmiersprache für Microsoft Dynamics 365 Business Central. AL-Quelldateien (`.al`) definieren Objekte wie `table`, `page`, `codeunit` etc. mit einem Header-Format: `table 55000 "My Table Name" { ... }`. Tables haben `field(ID; "Name"; DataType)`, Pages haben `field("Caption"; SourceExpression)`.

**Was wird generiert?** Eine Wiki-Hauptseite mit einer Übersichtstabelle aller AL-Objekte (gruppiert nach Typ), plus Sub-Pages mit Feldlisten für tables/tableextensions/pages/pageextensions. Links in der Hauptseite verweisen auf die Sub-Pages.

**Kontext**: Die bestehenden PowerShell-Skripte (`Generate-WikiObjectPage.ps1`, `Generate-WikiFieldPages.ps1`) im Repo unter `Scripts/` sind die Referenz-Implementierung. Die Extension ersetzt sie. Lies die Skripte bei Unklarheiten.

**Implementiere in 4 Phasen** (siehe unten). Teste nach jeder Phase.

---

## TL;DR

Eine VS Code Extension die ADO Wiki-Seiten aus AL-Quellcode generiert. Commands für Sync/Rebuild/Dry-Run, Tree View für Wiki-Seiten, PAT in VS Code SecretStorage. Config über `.devops-wiki.json` (committet, kein PAT). Projektübergreifend nutzbar — eine Extension für alle BC-Workspaces.

---

## Architektur

```
┌─────────────────────────────────────────────────────────┐
│  VS Code Extension: ado-wiki-sync                       │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Commands    │  │  Tree View   │  │  Status Bar   │  │
│  │  (Palette)   │  │  (Sidebar)   │  │  (Sync-Info)  │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │          │
│         ▼                ▼                   ▼          │
│  ┌────────────────────────────────────────────────────┐ │
│  │              Core Engine                           │ │
│  │                                                    │ │
│  │  wiki-client.ts    → ADO Wiki REST API (CRUD)     │ │
│  │  al-parser.ts      → AL-Datei-Parsing (Regex)     │ │
│  │  markdown-gen.ts   → Markdown-Erzeugung           │ │
│  │  sync-engine.ts    → Diff + Sync-Logik            │ │
│  │  config.ts         → .devops-wiki.json Handling   │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  Config: .devops-wiki.json (pro Workspace, committet)   │
│  PAT:    VS Code SecretStorage (pro Entwickler)         │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1: Extension-Grundgerüst + Wiki-CRUD

**Ziel**: Extension aktiviert sich, PAT-Management funktioniert, Wiki-Seiten lesen/schreiben/löschen/listen.

### Projekt-Struktur

```
C:\git\ado-wiki-sync\
├── package.json          # Extension Manifest + Commands + Settings
├── tsconfig.json
├── .vscodeignore
├── src/
│   ├── extension.ts      # activate() / deactivate()
│   ├── config.ts         # .devops-wiki.json laden + validieren
│   ├── auth.ts           # PAT via SecretStorage
│   ├── wiki-client.ts    # HTTP-Client (GET/PUT/DELETE mit ETag)
│   ├── commands/
│   │   ├── sync.ts
│   │   ├── rebuild.ts
│   │   ├── dry-run.ts
│   │   ├── read-page.ts
│   │   └── set-pat.ts
│   ├── id-manager.ts     # Nächste freie ID berechnen + CompletionProvider
│   ├── views/
│   │   └── wiki-tree.ts  # TreeDataProvider
│   └── status-bar.ts
└── README.md
```

### package.json (Extension Manifest)

```json
{
  "name": "ado-wiki-sync",
  "displayName": "ADO Wiki Sync for AL",
  "description": "Synchronizes Azure DevOps Wiki pages with Business Central AL source code",
  "version": "1.0.0",
  "publisher": "my-company",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other"],
  "activationEvents": [
    "workspaceContains:.devops-wiki.json"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "adoWikiSync.sync",
        "title": "Wiki: Sync",
        "category": "ADO Wiki",
        "icon": "$(sync)"
      },
      {
        "command": "adoWikiSync.rebuild",
        "title": "Wiki: Rebuild (komplett neu)",
        "category": "ADO Wiki"
      },
      {
        "command": "adoWikiSync.dryRun",
        "title": "Wiki: Dry-Run (Vorschau)",
        "category": "ADO Wiki",
        "icon": "$(eye)"
      },
      {
        "command": "adoWikiSync.setPat",
        "title": "Wiki: PAT konfigurieren",
        "category": "ADO Wiki"
      },
      {
        "command": "adoWikiSync.openPage",
        "title": "Wiki: Seite im Browser öffnen",
        "category": "ADO Wiki"
      },
      {
        "command": "adoWikiSync.nextId",
        "title": "Wiki: Nächste freie ID",
        "category": "ADO Wiki"
      },
      {
        "command": "adoWikiSync.showRanges",
        "title": "Wiki: ID-Ranges anzeigen",
        "category": "ADO Wiki"
      }
    ],
    "viewsContainers": {
      "activitybar": [
        {
          "id": "adoWikiSync",
          "title": "ADO Wiki",
          "icon": "$(book)"
        }
      ]
    },
    "views": {
      "adoWikiSync": [
        {
          "id": "adoWikiSync.pages",
          "name": "Wiki-Seiten"
        }
      ]
    },
    "menus": {
      "view/title": [
        {
          "command": "adoWikiSync.sync",
          "when": "view == adoWikiSync.pages",
          "group": "navigation"
        },
        {
          "command": "adoWikiSync.dryRun",
          "when": "view == adoWikiSync.pages",
          "group": "navigation"
        }
      ]
    }
  },
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "package": "vsce package",
    "publish": "vsce publish"
  },
  "devDependencies": {
    "@types/vscode": "^1.90.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.5.0",
    "@vscode/vsce": "^2.0.0"
  }
}
```

> Keine externen Runtime-Dependencies — nur Node.js built-ins (`https`, `fs`, `path`). Das hält die Extension leichtgewichtig.

### PAT-Management (auth.ts)

```typescript
import * as vscode from 'vscode';

const SECRET_KEY = 'adoWikiSync.pat';

export async function getPat(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return secrets.get(SECRET_KEY);
}

export async function setPat(secrets: vscode.SecretStorage): Promise<void> {
  const pat = await vscode.window.showInputBox({
    prompt: 'Azure DevOps PAT (Scope: Wiki Read/Write)',
    password: true,
    ignoreFocusOut: true,
  });
  if (pat) {
    await secrets.store(SECRET_KEY, pat);
    vscode.window.showInformationMessage('PAT gespeichert.');
  }
}
```

**Vorteile gegenüber Env-Variable**:
- OS-Keychain-verschlüsselt (Windows Credential Manager / macOS Keychain)
- Einmal eingeben, bleibt bis zum Löschen
- Kein `$PROFILE`-Eintrag nötig

### Wiki-Client (wiki-client.ts)

Nutzt `https` aus Node.js — keine Dependency. Gleiche REST-API wie im MCP-Plan.

```typescript
export class WikiClient {
  constructor(
    private pat: string,
    private orgUrl: string,
    private project: string,
    private wikiId: string,
  ) {}

  // Auth Header
  private get headers() {
    const b64 = Buffer.from(`:${this.pat}`).toString('base64');
    return {
      'Authorization': `Basic ${b64}`,
      'Content-Type': 'application/json',
    };
  }

  async readPage(path: string): Promise<{ content: string; etag: string }> { ... }
  async writePage(path: string, content: string): Promise<void> { ... }
  async deletePage(path: string): Promise<void> { ... }
  async listSubPages(parentPath: string): Promise<{ path: string; id: number }[]> { ... }
}
```

### MCP Tools (Phase 1) → Extension Commands

| MCP-Plan Tool | Extension Command | UI |
|---------------|-------------------|-----|
| `wiki_read` | `adoWikiSync.openPage` | Öffnet im Browser |
| `wiki_write` | intern (sync/rebuild) | — |
| `wiki_delete` | intern (sync) | — |
| `wiki_list` | Tree View Refresh | Sidebar |

### Technische Details

- **Activation**: `workspaceContains:.devops-wiki.json` — Extension aktiviert nur wenn Config existiert
- **Auth**: PAT in `SecretStorage`, Eingabe via Command `adoWikiSync.setPat`
- **ETag-Handling**: `writePage` holt automatisch ETag vor PUT
- **Config-Pfad**: Erste `.devops-wiki.json` im Workspace-Root. Multi-Root: je Workspace-Folder
- **Pfad-Auflösung**: Alle `appSources`-Pfade relativ zur Config-Datei
- **Retry**: 412 → 1x Retry. 429 → exponentieller Backoff
- **Output Channel**: `ADO Wiki Sync` — alle Logs dort (nicht in Notification-Spam)

---

## Phase 2: AL-Parsing

**Ziel**: Extension kann AL-Quellcode analysieren und strukturierte Objekt-/Feld-Listen zurückgeben.

### al-parser.ts

```typescript
export interface AlObject {
  app: string;
  type: string;
  id: number;
  name: string;
  filePath: string;
}

export interface TableField {
  id: number;
  name: string;
  dataType: string;
  fieldClass?: string;  // Normal, FlowField, FlowFilter
}

export interface PageField {
  caption: string;
  sourceExpression: string;
}

export function parseObjectsFromConfig(configPath: string): AlObject[] { ... }
export function parseTableFields(filePath: string): TableField[] { ... }
export function parsePageFields(filePath: string): PageField[] { ... }
```

### Regex-Referenz

```typescript
// Objekt-Header (aus Referenz-PS1, getestet mit 1113 Objekten)
const OBJ_REGEX = /^\s*(table|tableextension|page|pageextension|codeunit|report|enum|enumextension|query|xmlport|permissionset|reportextension)\s+(\d+)\s+"?([^"\r\n{]+)"?/m;

// Table Field: field(ID; "Name"; DataType)
const TABLE_FIELD_REGEX = /field\(\s*(\d+)\s*;\s*"([^"]+)"\s*;\s*([^)]+?)\s*\)\s*\{/gms;

// Page Field: field("Caption"; SourceExpr)
const PAGE_FIELD_REGEX = /field\(\s*"([^"]+)"\s*;\s*([^){;]+)/gm;
```

### App-Name-Auflösung

`parseObjectsFromConfig` liest `app.json` jeder `appSource` und extrahiert `name` als App-Zuordnung.

### `.objidconfig`-Format (für Ranges)

```json
{
  "objectRanges": {
    "table": [{ "from": 55000, "to": 55319, "description": "My-App-Range" }],
    "codeunit": [{ "from": 55000, "to": 55319, "description": "My-App-Range" }]
  }
}
```

> **Achtung**: Das Feld heißt `objectRanges` (nicht `idRanges`). Falls `objIdConfig` null → Ranges aus `app.json` → `idRanges` (BC-Standardformat, ohne Typ-Aufteilung).

---

## Phase 3: Sync-Engine + Markdown-Generierung

**Ziel**: Sync und Rebuild vollständig in der Extension. Mit Progress-Reporting.

### sync-engine.ts

```typescript
export interface SyncResult {
  added: number;
  removed: number;
  updated: number;
  errors: number;
  details: string[];
}

export async function rebuild(
  config: Config,
  client: WikiClient,
  progress: vscode.Progress<{ message: string; increment: number }>,
  token: vscode.CancellationToken,
): Promise<SyncResult> { ... }

export async function sync(
  config: Config,
  client: WikiClient,
  dryRun: boolean,
  progress: vscode.Progress<{ message: string; increment: number }>,
  token: vscode.CancellationToken,
): Promise<SyncResult> { ... }
```

### Rebuild-Ablauf

```
1. parseObjectsFromConfig(configPath) → objects[]
2. Ranges aus .objidconfig lesen
3. generateObjectPageMarkdown(...) → markdown
4. client.writePage(basePath, markdown)
5. Für jedes table/tableext/page/pageext:
   a. parseTableFields/parsePageFields(filePath) → fields
   b. generateFieldPageMarkdown(...) → markdown
   c. client.writePage(basePath + "/" + type + "-" + id, markdown)
   d. await sleep(150ms)
   e. progress.report({ message: `${type}-${id}`, increment: 100/total })
6. Return { created, updated, errors }
```

> Rebuild: ~94s für 628 Pages. User sieht VS Code Progress-Bar mit Cancel-Button.

### Sync-Ablauf

```
1. parseObjectsFromConfig(configPath) → sourceObjects (Soll)
2. client.listSubPages(basePath) → wikiSubPages (Ist)
3. Diff:
   a. Neu in Source → Sub-Page erstellen
   b. Im Wiki, nicht in Source → Sub-Page löschen
   c. In beiden → Feldvergleich → bei Änderung aktualisieren
4. Hauptseite regenerieren:
   a. Bestehende Hauptseite GET → Ranges-Abschnitt extrahieren + ERHALTEN
   b. Objekt-Tabellen neu generieren
   c. Finales Markdown = Ranges-Abschnitt (erhalten) + neue Tabellen
   d. client.writePage(basePath, finalMarkdown)
5. Return summary
```

### Ranges-Extraktion aus bestehender Hauptseite

```
Start: Zeile die mit "## ID-Ranges" beginnt (oder "## Ranges")
Ende:  Nächste Zeile die mit "## " beginnt (nächste H2-Überschrift)
```

Alles dazwischen 1:1 erhalten. Falls kein Ranges-Abschnitt existiert: keinen erzeugen.

### Objekt-Gruppierung in der Hauptseite

Jeder Objekttyp bekommt eine eigene H2-Überschrift (NICHT zusammengefasst):

```
## Codeunits
## Enums
## Enum Extensions
## Pages
## Page Extensions
## Permission Sets
## Queries
## Reports
## Report Extensions
## Tables
## Table Extensions
## XMLports
```

Reihenfolge: alphabetisch nach Label. Innerhalb jeder Gruppe: sortiert nach ID. Nur Gruppen mit ≥1 Objekt.

### Markdown-Struktur Hauptseite

```markdown
# Objekt-IDs

> Automatisch generiert aus dem Quellcode. Stand: {yyyy-MM-dd}

## ID-Ranges (freie Bereiche)

> Initalbefuellung aus `.objidconfig`. Wird manuell gepflegt.

| App | Typ | Von | Bis | Beschreibung |
|-----|-----|-----|-----|--------------|
| My-Base-App | codeunit | 55000 | 55319 | My-App-Range |

## Tables

| App | Typ | ID | Name |
|-----|-----|----|------|
| My-Base-App | table | [55000](https://dev.azure.com/{org}/{project}/_wiki/wikis/{wikiId}?pagePath=%2FInhalt%2FObjekt-IDs%2Ftable-55000) | My Base Setup |
```

### Link-Format (KRITISCH)

```
[{id}](https://dev.azure.com/{org}/{project}/_wiki/wikis/{wikiId}?pagePath={urlEncodedPath})
```

- **NICHT** relative Links (`./page`) — werden falsch aufgelöst
- **NICHT** absolute Server-Pfade (`/Inhalt/...`) — werden als Server-URL interpretiert
- **NUR** vollqualifizierte `pagePath`-URLs funktionieren zuverlässig

Links nur für Typen mit Sub-Pages: `table`, `tableextension`, `page`, `pageextension`. Alle anderen: plain ID ohne Link.

### Sub-Page Namensschema

Deterministisch: `{type}-{id}` → z.B. `table-55000`, `pageextension-55123`

### Markdown-Struktur Sub-Pages

**Tables/TableExtensions:**
```markdown
# {type} {id} – {name}

| Field ID | Field Name | Data Type | Field Class |
|----------|-----------|-----------|-------------|
| 1 | Primary Key | Code[20] | Normal |
```

**Pages/PageExtensions:**
```markdown
# {type} {id} – {name}

| Caption | Source Expression |
|---------|------------------|
| Nr. | "No." |
```

---

## Phase 4: Tree View + Status Bar + UX

**Ziel**: Native VS Code UI-Integration für maximale Benutzbarkeit.

### Tree View (wiki-tree.ts)

```
📖 ADO Wiki                          [🔄] [👁]
├── � ID-Ranges
│   ├── table: 55000-55319 (23 belegt, 297 frei)
│   ├── page: 55000-55319 (42 belegt, 278 frei)
│   └── codeunit: 55000-55319 (67 belegt, 253 frei)
├── �📄 Hauptseite (1113 Objekte)      → Öffnet im Browser
├── 📁 Tables (23)
│   ├── 📄 table-55000 – My Base Setup
│   ├── 📄 table-55001 – My Base Line
│   └── ...
├── 📁 Table Extensions (15)
├── 📁 Pages (42)
├── 📁 Page Extensions (38)
└── 📊 Letzte Sync: 14.07.2026 15:32 (0 Änderungen)
```

**Interaktionen**:
- Klick auf Seite → im Browser öffnen (`vscode.env.openExternal`)
- Refresh-Button → `client.listSubPages` neu laden
- Eye-Button → Dry-Run

### Status Bar

```
$(book) Wiki: ✓ synced  |  $(clock) 14:32
```

- Klick → Command Palette mit Wiki-Commands
- Gelb/Warnung wenn `.devops-wiki.json` existiert aber kein PAT gesetzt

### Commands (Zusammenfassung)

| Command | Palette-Text | Was passiert |
|---------|-------------|--------------|
| `adoWikiSync.sync` | "Wiki: Sync" | Sync mit Progress-Bar |
| `adoWikiSync.rebuild` | "Wiki: Rebuild" | Komplett-Rebuild mit Bestätigungs-Dialog |
| `adoWikiSync.dryRun` | "Wiki: Dry-Run" | Sync-Vorschau im Output Channel |
| `adoWikiSync.setPat` | "Wiki: PAT konfigurieren" | SecretStorage-Eingabe |
| `adoWikiSync.openPage` | "Wiki: Seite im Browser" | Quick-Pick + Browser |
| `adoWikiSync.nextId` | "Wiki: Nächste freie ID" | QuickPick: Typ wählen → ID in Clipboard + ans Cursor |
| `adoWikiSync.showRanges` | "Wiki: ID-Ranges anzeigen" | Output Channel: Alle Ranges mit Belegt/Frei pro Typ |

### Rebuild-Bestätigung

```typescript
const answer = await vscode.window.showWarningMessage(
  'Rebuild überschreibt alle Wiki-Seiten. Fortfahren?',
  { modal: true },
  'Ja, Rebuild starten'
);
```

### Ergebnis-Anzeige nach Sync

```typescript
// Bei 0 Änderungen: kurze Notification
vscode.window.showInformationMessage('Wiki ist aktuell — 0 Änderungen.');

// Bei Änderungen: Details im Output Channel
outputChannel.appendLine(`Sync abgeschlossen: +${result.added} -${result.removed} ~${result.updated}`);
outputChannel.show();
```

---

## Konfigurationsdatei: `.devops-wiki.json`

Liegt im Workspace-Root (neben `app/`). Wird ins Repo **committet** (enthält keinen PAT).

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "my-base-app",
  "wikiId": "My-Base-App.wiki",
  "basePath": "/Inhalt/Objekt-IDs",
  "appSources": [
    {
      "appJson": "app/app.json",
      "srcPath": "app/src",
      "objIdConfig": "app/.objidconfig"
    },
    {
      "appJson": "../IntraStat/app/app.json",
      "srcPath": "../IntraStat/app/src",
      "objIdConfig": null
    },
    {
      "appJson": "../EDIFramework/app/app.json",
      "srcPath": "../EDIFramework/app/src",
      "objIdConfig": null
    }
  ]
}
```

**Alle `appSources`-Pfade relativ zur Position der `.devops-wiki.json`.**

> Kein `patEnvVar` mehr — PAT liegt in VS Code SecretStorage.

### Felder

| Feld | Pflicht | Beschreibung |
|------|---------|--------------|
| `orgUrl` | Ja | `https://dev.azure.com/{organisation}` |
| `project` | Ja | Projektname in ADO |
| `wikiId` | Ja | Wiki-Identifier (meist `{Projektname}.wiki`) |
| `basePath` | Ja | Basis-Pfad unter dem alle Objekt-Seiten liegen |
| `appSources` | Ja | Array der AL-App-Quellen (relativ zur Config-Datei) |
| `appSources[].appJson` | Ja | Pfad zur `app.json` (für App-Name) |
| `appSources[].srcPath` | Ja | Pfad zum `src/`-Ordner |
| `appSources[].objIdConfig` | Nein | Pfad zur `.objidconfig` (für Ranges) |

---

## API-Referenz (Azure DevOps Wiki REST API v7.1)

### Endpunkte

```
Base: {orgUrl}/{project}/_apis/wiki/wikis/{wikiId}/pages

GET    ?path={encoded}&includeContent=true&api-version=7.1                    → Seite lesen
GET    ?path={encoded}&recursionLevel=oneLevel&api-version=7.1                → Sub-Pages auflisten
PUT    ?path={encoded}&api-version=7.1                                         → Seite erstellen/aktualisieren
DELETE ?path={encoded}&api-version=7.1                                         → Seite löschen
```

### Sub-Pages auflisten

```
GET {base}?path={encodedParentPath}&recursionLevel=oneLevel&api-version=7.1
```

Response:
```json
{
  "id": 1405,
  "path": "/Inhalt/Objekt-IDs",
  "subPages": [
    { "id": 2314, "path": "/Inhalt/Objekt-IDs/table-55036" },
    { "id": 2315, "path": "/Inhalt/Objekt-IDs/pageextension-55000" }
  ]
}
```

### Authentifizierung

```
Authorization: Basic {base64(":$pat")}
Content-Type: application/json
```

### ETag-Workflow

```
1. GET Seite → Response Header enthält ETag
2. PUT mit Header: If-Match: {etag}
   Body: { "content": "markdown string" }
```

Ohne `If-Match` bei existierender Seite → Error "page already exists".

### Rate Limiting

150ms Delay zwischen Requests. Bei Bulk (Rebuild): mit `await sleep(150)`.

### Fehlerbehandlung

| Status | Bedeutung | Aktion |
|--------|-----------|--------|
| 200 | Erfolg | — |
| 404 | Seite nicht vorhanden | Read: Fehler. Write: Create (kein ETag nötig) |
| 412 | ETag mismatch | Neu holen, 1x Retry |
| 429 | Rate Limited | Delay erhöhen, Retry |

---

## Umsetzungsreihenfolge

Implementiere strikt in dieser Reihenfolge. Teste nach jeder Phase.

| Phase | Aufwand | Abnahme |
|-------|---------|--------|
| **1: Grundgerüst + CRUD** | ~2h | Command "Wiki: PAT konfigurieren" → PAT speichern. `WikiClient.readPage("/Inhalt/Objekt-IDs/table-55000")` → Markdown zurück |
| **2: AL-Parsing** | ~1h | `parseObjectsFromConfig(configPath)` → 1113 Objekte mit App-Namen |
| **3: Sync-Engine** | ~2h | Command "Wiki: Dry-Run" → "0 Änderungen" (Wiki ist bereits aktuell via PS1) |
| **4: Tree View + UX** | ~1.5h | Sidebar zeigt Wiki-Seiten, Status Bar zeigt Sync-Status |
| **5: ID-Vergabe** | ~1h | Command "Nächste freie ID" → table wählen → 55042. CompletionProvider: `table ` + Space → ID-Vorschlag |

### Test-Anleitung pro Phase

**Phase 1**: Extension aktivieren (`workspaceContains:.devops-wiki.json`). PAT setzen. Output Channel "ADO Wiki Sync" prüfen — `readPage` auf eine bekannte Seite muss Markdown zurückgeben.

**Phase 2**: Debugging-Session. `parseObjectsFromConfig` aufrufen. Erwartung: Array mit ~1113 Objekten. Stichprobe: table 55000 = "My Base Setup", app = "My-Base-App".

**Phase 3**: Command "Wiki: Dry-Run" ausführen. Da das Wiki aktuell ist, muss "0 Änderungen" kommen. Falls Differenzen: Markdown-Generierung weicht vom bestehenden Wiki ab.

**Phase 4**: Sidebar öffnen. Tree View muss Sub-Pages gruppiert nach Typ anzeigen. Klick auf Seite öffnet Browser. Status Bar zeigt "Wiki: ✓ synced".

**Phase 5**: Command "Wiki: Nächste freie ID" ausführen. Typ "table" wählen. Erwartung: nächste freie ID wird angezeigt (z.B. 55042) und in Clipboard kopiert. In `.al`-Datei `table ` tippen + Space → CompletionProvider schlägt die ID vor. Tree View zeigt Ranges-Node mit Belegt/Frei-Zahlen.

---

## Vergleich: Extension vs. MCP Server

| Aspekt | Extension | MCP Server |
|--------|-----------|------------|
| Trigger | Command Palette, Sidebar-Button, Keyboard Shortcut | Chat oder Terminal |
| Ohne AI nutzbar | Ja, komplett eigenständig | Nur via Chat oder CLI |
| UI | Native VS Code (Tree View, Progress, Status Bar) | Text-Output |
| PAT-Speicher | OS Keychain (SecretStorage) | Env-Variable |
| Installation | `.vsix` oder Marketplace | `npm install -g` |
| Auto-Aktivierung | `workspaceContains:.devops-wiki.json` | Manuell konfigurieren |
| Dependency | 0 (nur Node.js built-ins) | `@modelcontextprotocol/sdk` |
| MCP-Integration | Nicht vorhanden | Ja |
| Komplexität | Mittel (Extension API) | Gering (MCP SDK) |

> Die Extension kann auch **zusätzlich zum MCP** existieren — gleiche `config.ts`, `wiki-client.ts`, `al-parser.ts`, `markdown-gen.ts`. Shared Core, verschiedene Shells.

---

## Entscheidungen

| Entscheidung | Begründung |
|---|---|
| PAT in SecretStorage | OS-Keychain-verschlüsselt; kein Env-Variable-Setup nötig |
| Keine Runtime-Dependencies | Schnelle Aktivierung; `https`/`fs`/`path` aus Node.js reichen |
| `activationEvents: workspaceContains` | Extension schläft in Workspaces ohne Config |
| Output Channel statt Notifications | Sync-Details sind lang; Notifications nur für Summary |
| Tree View in eigener Activity Bar | Sichtbar aber nicht aufdringlich |
| Config-Datei statt VS Code Settings | Committet ins Repo; alle Entwickler haben die gleiche Config |
| Rebuild mit Bestätigungs-Dialog | Destruktive Operation — kein versehentliches Überschreiben |
| Progress-Bar mit Cancel | Rebuild dauert ~94s — User muss Fortschritt sehen und abbrechen können |
| Typ-Labels einzeln (nicht gruppiert) | Konsistent mit Referenz-PS1; `Table Extensions` ≠ `Tables` |
| `objectRanges` (nicht `idRanges`) | So heißt das Feld in der `.objidconfig` (verifiziert im PS1-Skript) |

---

## Bekannte Fallstricke (aus der Referenz-Implementierung)

| Problem | Lösung |
|---------|--------|
| ADO Wiki relative Links (`./page`) werden falsch aufgelöst | **NUR** vollqualifizierte `pagePath`-URLs verwenden |
| PUT auf existierende Seite ohne ETag → "page already exists" | Immer erst GET → ETag → PUT mit `If-Match` |
| Wiki-Seitennamen mit Bindestrich werden in URLs zu Space | `encodeURIComponent()` für Pfade verwenden |
| Bulk-Operationen (628 Pages) lösen Rate Limiting aus | 150ms `await sleep()` zwischen Requests |
| `recursionLevel=full` liefert den ganzen Wiki-Baum | `oneLevel` verwenden für Sub-Page-Listing |

---

## Phase 5: ID-Vergabe (wie bestehende ID-Management Tools)

**Ziel**: Nächste freie Objekt-ID vorschlagen — aus den bereits geladenen Ranges und belegten IDs. Kein separates Tool nötig.

**Ablauf**:
1. User erstellt neue `.al`-Datei oder tippt `table ` / `page ` etc.
2. Extension erkennt fehlende/Platzhalter-ID (z.B. `table 0 "..."` oder leerer Snippet)
3. Berechnet nächste freie ID für diesen Typ aus Range
4. Zeigt Suggestion als InlineCompletion oder QuickPick: `Nächste freie Table-ID: 55042`
5. User akzeptiert → ID wird eingesetzt

**Implementierung** (`src/id-manager.ts`):

```typescript
export interface IdSuggestion {
  type: string;
  nextFreeId: number;
  range: { from: number; to: number };
  usedCount: number;
  freeCount: number;
}

export function getNextFreeId(
  type: string,
  objects: AlObject[],
  ranges: ObjectRange[],
): IdSuggestion | null {
  const usedIds = new Set(
    objects.filter(o => o.type === type).map(o => o.id)
  );
  for (const range of ranges) {
    for (let id = range.from; id <= range.to; id++) {
      if (!usedIds.has(id)) {
        return {
          type,
          nextFreeId: id,
          range,
          usedCount: usedIds.size,
          freeCount: range.to - range.from + 1 - usedIds.size,
        };
      }
    }
  }
  return null; // Range voll
}
```

**Tree View Erweiterung** — Ranges-Node im Baum:

```
📖 ADO Wiki                          [🔄] [👁]
├── 📊 ID-Ranges
│   ├── table: 55000-55319 (23 belegt, 297 frei)
│   ├── page: 55000-55319 (42 belegt, 278 frei)
│   └── codeunit: 55000-55319 (67 belegt, 253 frei)
├── 📄 Hauptseite (1113 Objekte)
├── 📁 Tables (23)
│   └── ...
```

**CompletionProvider** (optional, fortgeschritten):

```typescript
vscode.languages.registerCompletionItemProvider(
  { language: 'al' },
  {
    provideCompletionItems(doc, pos) {
      const line = doc.lineAt(pos).text;
      // Erkennt: "table " am Zeilenanfang ohne ID
      const match = line.match(/^\s*(table|page|codeunit|...)\s+$/);
      if (match) {
        const suggestion = getNextFreeId(match[1], ...);
        if (suggestion) {
          const item = new vscode.CompletionItem(
            `${suggestion.nextFreeId}`,
            vscode.CompletionItemKind.Value
          );
          item.detail = `Nächste freie ${match[1]}-ID (Range ${suggestion.range.from}-${suggestion.range.to})`;
          return [item];
        }
      }
    }
  },
  ' ' // Trigger auf Space nach Typ-Keyword
);
```

> **Vorteil gegenüber anderen Tools**: Keine separate Extension, gleiche Config, gleiche Ranges-Quelle, und die ID taucht beim nächsten Wiki-Sync automatisch im Wiki auf.

---

## Optionale Erweiterungen (nach v1.0)

- **File Watcher**: `.al`-Dateiänderungen erkennen → Status Bar gelb "Wiki: out of sync"
- **Diff View**: Vor dem Sync zeigen was sich ändern würde (VS Code Diff Editor)
- **Inline CodeLens**: In `.al`-Dateien "Wiki-Seite öffnen" über dem Objekt-Header
- **MCP-Companion**: Gleicher Core als MCP Server exponiert (Hybrid-Lösung)
