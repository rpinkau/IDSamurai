# Implementierungsplan: IDSamurai MCP Server

## Ziel

IDSamurai erhält einen integrierten **Model Context Protocol (MCP) Server**, der KI-Agenten (Cursor, Claude Desktop, GitHub Copilot etc.) ermöglicht, Objekt-IDs sicher über das Azure DevOps Wiki zu verwalten – genau wie ein menschlicher Entwickler über die UI.

---

## Bestehende Bausteine (Wiederverwendung)

Die gesamte Geschäftslogik existiert bereits. Der MCP-Server ist im Wesentlichen eine neue **Fassade** (Thin Layer) über bestehenden Modulen.

| Bestehend | Datei | Nutzung im MCP |
|-----------|-------|----------------|
| Wiki-Verbindung (PAT, Read/Write/Delete) | `src/wiki-client.ts` | Alle Tools nutzen denselben `WikiClient` |
| Konfiguration laden | `src/config.ts` | MCP-Server liest `.devops-wiki.json` beim Start |
| AL-Objekte parsen | `src/al-parser.ts` | `list_objects`, `get_object_info` |
| Einzelne ID reservieren (mit Lock-ID + Retry) | `src/id-manager.ts` (Zeile 173–239) | `reserve_new_id` |
| Bulk-Reservierung (mit Cache) | `src/commands/id-commands.ts` (Zeile 195–279) | `reserve_id_batch` |
| ID freigeben (Wiki-Seite löschen) | `src/commands/id-commands.ts` (Zeile 130–181) | `reclaim_id` |
| Range-Statistiken (lokal + Wiki) | `src/id-manager.ts` (Zeile 292–401) | `get_range_stats` |
| Sub-Page-Parsing (Typ + ID aus Pfad) | `src/markdown-gen.ts` (Zeile 239–246) | `check_id_status` |

---

## Vollständige Tool-Liste (8 Tools)

### Kern-Tools (ID-Lebenszyklus)

#### 1. `reserve_new_id`
Reserviert die nächste freie ID für einen Objekttyp im Wiki.

| Parameter | Typ | Required | Beschreibung |
|-----------|-----|----------|-------------|
| `type` | string | ✅ | Objekttyp: `table`, `page`, `codeunit`, `report`, `enum`, `xmlport`, `query` |
| `name` | string | ❌ | Objekt-Name für die Wiki-Beschreibung |

**Rückgabe:** `{ id: 50100, type: "table", app: "MainApp", remaining_free: 42 }`
**Logik:** Delegiert an `reserveId()` aus `id-manager.ts` (inkl. Lock-ID + Retry-Mechanismus).

---

#### 2. `reserve_id_batch`
Reserviert **mehrere IDs auf einmal**, optional als zusammenhängenden Block.

| Parameter | Typ | Required | Beschreibung |
|-----------|-----|----------|-------------|
| `requests` | array | ✅ | Array von `{ type, count, consecutive? }` |
| `feature_name` | string | ❌ | Feature-Name für alle Reservierungen (z.B. "Sales Order Extension") |

**Beispiel-Aufruf:**
```json
{
  "requests": [
    { "type": "table", "count": 2, "consecutive": true },
    { "type": "page", "count": 2, "consecutive": true },
    { "type": "codeunit", "count": 1 }
  ],
  "feature_name": "Customer Rating Feature"
}
```

**Rückgabe:** 
```json
{
  "reservations": {
    "table": [50100, 50101],
    "page": [50200, 50201],
    "codeunit": [50300]
  },
  "feature_name": "Customer Rating Feature"
}
```

**Logik:** Erweiterte Version von `registerBulkReserveCommand()`. Für `consecutive: true` muss ein zusammenhängender Lückenblock im Range gesucht werden (neue Hilfsfunktion `findConsecutiveFreeBlock()`).

**WICHTIG – Neu zu entwickeln:** Die bestehende Bulk-Reservierung reserviert einzeln nacheinander. Für `consecutive: true` brauchen wir eine neue Funktion, die vorab prüft, ob ein zusammenhängender Block existiert, und diesen atomar reserviert.

---

#### 3. `reclaim_id`
Gibt eine reservierte oder nicht mehr benötigte ID wieder frei.

| Parameter | Typ | Required | Beschreibung |
|-----------|-----|----------|-------------|
| `type` | string | ✅ | Objekttyp |
| `id` | number | ✅ | Die freizugebende ID |

**Rückgabe:** `{ status: "released", message: "ID 50100 ist jetzt wieder frei." }`
**Logik:** Delegiert an `client.deletePage()`. Prüft vorher, ob die Seite existiert und ob sie *nur* eine Reservation ist (nicht ein echtes Objekt mit Feldern).

---

#### 4. `check_id_status`
Prüft, ob eine bestimmte ID frei oder belegt ist.

| Parameter | Typ | Required | Beschreibung |
|-----------|-----|----------|-------------|
| `type` | string | ✅ | Objekttyp |
| `id` | number | ✅ | Die zu prüfende ID |

**Rückgabe:**
```json
{
  "is_free": false,
  "local_object": { "name": "Customer", "file": "src/Customer.Table.al" },
  "wiki_reserved": true,
  "in_range": true
}
```
**Logik:** Kombiniert lokales Parsen (`parseObjectsFromConfig`) mit Wiki-Abfrage (`readPage`).

---

### Kontext-Tools (Read-Only, für intelligente Entscheidungen)

#### 5. `get_range_stats`
Gibt der KI einen Überblick über die verfügbaren ID-Bereiche.

| Parameter | Typ | Required | Beschreibung |
|-----------|-----|----------|-------------|
| `app_name` | string | ❌ | Filter auf eine bestimmte App |

**Rückgabe:**
```json
[
  { "type": "table", "app": "MainApp", "range": "50000-50219", "used": 48, "free": 172 },
  { "type": "page", "app": "MainApp", "range": "50000-50399", "used": 91, "free": 309 }
]
```
**Logik:** Delegiert an `getRangeStatsWithWiki()`.

---

#### 6. `list_objects`
Listet alle bekannten AL-Objekte (lokal + Wiki) eines bestimmten Typs auf.

| Parameter | Typ | Required | Beschreibung |
|-----------|-----|----------|-------------|
| `type` | string | ❌ | Optional filtern nach Typ |
| `app_name` | string | ❌ | Optional filtern nach App |

**Rückgabe:** Array von `{ type, id, name, app, file?, summary? }`
**Logik:** `parseObjectsFromConfig()` + optional Wiki-Objekte aus Hauptseite. Die KI kann so z.B. fragen: *"Welche Tabellen existieren?"* bevor sie eine Extension baut.

**Warum ist das nützlich?** Eine KI, die eine TableExtension schreiben soll, muss wissen, welche Tabellen überhaupt existieren und welche IDs sie haben. Ohne dieses Tool müsste sie raten oder den User fragen.

---

#### 7. `get_object_info`
Gibt detaillierte Informationen über ein spezifisches Objekt zurück (Felder, Summary etc.).

| Parameter | Typ | Required | Beschreibung |
|-----------|-----|----------|-------------|
| `type` | string | ✅ | Objekttyp |
| `id` | number | ✅ | Objekt-ID |

**Rückgabe:**
```json
{
  "type": "table",
  "id": 50100,
  "name": "Customer Rating",
  "app": "MainApp",
  "summary": "Stores customer satisfaction ratings",
  "fields": [
    { "id": 1, "name": "Entry No.", "dataType": "Integer" },
    { "id": 10, "name": "Customer No.", "dataType": "Code[20]" }
  ]
}
```
**Logik:** `parseObjectHeader()` + `parseTableFields()` / `parsePageFields()`. Die KI kann damit z.B. die Felder einer Tabelle lesen, um korrekte SourceExpressions in einer Page zu generieren.

**Warum ist das nützlich?** Wenn die KI eine Page für eine bestimmte Tabelle bauen soll, muss sie die Felder dieser Tabelle kennen. Statt die Datei selbst zu parsen, fragt sie den MCP-Server, der die AL-Syntax schon versteht.

---

#### 8. `validate_al_file`
Prüft eine AL-Datei auf ID-Konflikte und Range-Verletzungen (wie der Live-Linter).

| Parameter | Typ | Required | Beschreibung |
|-----------|-----|----------|-------------|
| `file_path` | string | ✅ | Pfad zur AL-Datei |

**Rückgabe:**
```json
{
  "valid": false,
  "issues": [
    { "severity": "error", "message": "ID 50100 ist bereits durch 'Customer.Table.al' belegt", "line": 1 },
    { "severity": "warning", "message": "ID 60000 liegt außerhalb der lizenzierten Ranges", "line": 1 }
  ]
}
```
**Logik:** Nutzt die gleiche Logik wie `src/diagnostics.ts`, aber als synchrone JSON-Antwort statt VS-Code-Diagnostics.

**Warum ist das nützlich?** Bevor die KI eine Datei als "fertig" markiert, kann sie sie validieren lassen. So fängt der IDSamurai Fehler *vor* dem Speichern ab – wie ein zusätzlicher Linter speziell für IDs.

---

## Architektur

### Transport-Mechanismus

**ENTSCHEIDUNG ERFORDERLICH:** Es gibt zwei Optionen:

**Option A: Integriert in die VS Code Extension (stdio-basiert)**
- Der MCP-Server startet als Child-Process, den die VS Code Extension beim Aktivieren hochfährt.
- Kommunikation via stdin/stdout (Standard-MCP-Protokoll).
- Vorteil: Teilt sich die Config und den PAT mit der Extension, kein separater Setup-Schritt.
- Nachteil: Funktioniert nur, wenn VS Code läuft.

**Option B: Eigenständiger Node.js-Prozess**  
- Ein separates CLI-Script (`npx idsamurai-mcp`) das unabhängig von VS Code läuft.
- Muss Config und PAT selbst lesen (z.B. aus `.devops-wiki.json` + Environment Variable).
- Vorteil: Funktioniert auch mit Cursor, Claude Desktop, beliebigen MCP-Clients.
- Nachteil: Separates Paket, Duplikation von Config-Logik.

**Empfehlung:** Option A als Erstes, weil wir sämtliche bestehende Logik (Config, WikiClient, Parser) direkt importieren können. Option B kann später als Spin-off kommen.

### Dateistruktur

```
src/
├── mcp/
│   ├── mcp-server.ts          # MCP Server Setup & Tool-Registry
│   ├── tools/
│   │   ├── reserve-new-id.ts   # Tool 1
│   │   ├── reserve-id-batch.ts # Tool 2 (inkl. consecutive-Logik)
│   │   ├── reclaim-id.ts       # Tool 3
│   │   ├── check-id-status.ts  # Tool 4
│   │   ├── get-range-stats.ts  # Tool 5
│   │   ├── list-objects.ts     # Tool 6
│   │   ├── get-object-info.ts  # Tool 7
│   │   └── validate-al-file.ts # Tool 8
│   └── mcp-types.ts            # Shared MCP interfaces
├── extension.ts                # Startet MCP-Server im activate()
└── ...bestehende Dateien...
```

---

## Phasen

### Phase 1: MCP-Grundgerüst + Kern-Tools (Tools 1–4)
1. MCP SDK installieren (`@modelcontextprotocol/sdk`)
2. `mcp-server.ts` erstellen (Server-Setup, Tool-Registry)
3. `reserve-new-id.ts` implementieren (delegiert an `reserveId()`)
4. `reserve-id-batch.ts` implementieren (inkl. neue `findConsecutiveFreeBlock()` Funktion)
5. `reclaim-id.ts` implementieren (delegiert an `client.deletePage()`)
6. `check-id-status.ts` implementieren
7. MCP-Server in `extension.ts` starten

### Phase 2: Kontext-Tools (Tools 5–8)
1. `get-range-stats.ts` implementieren
2. `list-objects.ts` implementieren
3. `get-object-info.ts` implementieren
4. `validate-al-file.ts` implementieren

### Phase 3: Integration & Dokumentation
1. `package.json` um MCP-Konfiguration erweitern
2. README um MCP-Abschnitt erweitern (Setup-Anleitung für Cursor/Claude)
3. Beispiel-`cursorrules`-Datei generieren, die erklärt, wie die KI IDSamurai nutzen soll
4. Version auf 1.9.0 hochzählen

---

## Offene Fragen

1. **Transport:** Option A (in VS Code integriert) oder Option B (eigenständig)? Oder beides?
2. **Feld-IDs:** Soll `reserve_new_id` auch **Table-Field-IDs** unterstützen (z.B. "gib mir die nächste freie Feld-ID in Tabelle 50100")? Das wäre für KIs, die Tabellen-Felder generieren, extrem hilfreich. Die Logik existiert schon in `src/al-completion.ts` (Zeile 22–80).
3. **Sicherheitsgrenzen:** Soll der MCP-Server ein maximales Limit pro Batch haben (z.B. max. 50 IDs auf einmal), damit eine KI nicht versehentlich 10.000 Reservierungen anlegt?
4. **Auth:** Nutzt der MCP-Server den gleichen PAT wie die Extension, oder soll ein separater Token konfigurierbar sein?

## Verifikation

### Automatisiert
- `npm run compile` muss fehlerfrei durchlaufen
- `npm run package` muss eine gültige `.vsix` erzeugen

### Manuell
- MCP-Server über Cursor oder Claude Desktop anbinden und testen:
  - `reserve_new_id(type="table")` → reserviert im Wiki
  - `reserve_id_batch(requests=[{type:"table", count:3, consecutive:true}])` → 3 aufeinanderfolgende IDs
  - `reclaim_id(type="table", id=50100)` → gibt frei
  - `check_id_status(type="table", id=50100)` → zeigt Status
