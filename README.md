# IDSamurai

<div align="center">
  <img src="images/icon.png" width="128" height="128" alt="IDSamurai Logo" />
  <br/>
  <b>Die ultimative AL ID-Management & Dokumentations-Pipeline für Business Central Entwickler.</b>
</div>

<br />

*[English below](#english)*

## 🇩🇪 Deutsch

**Dein IDSamurai** verhindert effektiv Nummernkonflikte bei Objekten über mehrere Entwickler hinweg. In einem Wiki (wie dem Azure DevOps Wiki) werden die Objektnummern abgelegt, und beim Ziehen einer neuen Objektnummer werden diese von dort aus automatisiert verteilt. Anstelle von mühsamen, manuellen Exceltabellen synchronisiert IDSamurai deine Wiki-Seiten vollautomatisch in Echtzeit mit deinem AL-Quellcode. Keine veralteten Dokumentationen und keine Kollisionen mehr – dein Code ist die Single Source of Truth!

> [!NOTE]
> Für Entwicklerteams, die es satt haben, ihre Objekte in Excel zu dokumentieren. Entwickelt für moderne AL-Entwickler, die eine reibungslose Dokumentations-Pipeline direkt aus dem Code-Editor (VS Code) heraus benötigen.

### ✨ Highlights & Features

- 🛡️ **IntelliSense (Live Linter & Quick-Fix)**: Sobald du eine Objekt-ID eintippst, die bereits von einem Kollegen reserviert wurde, unterstreicht IDSamurai den Fehler sofort live im Editor. Ein Klick (Alt+Enter) reicht, und IDSamurai schlägt dir direkt die nächste freie ID aus dem Wiki vor und fügt sie in deinen Code ein.
- 🌳 **Integrierter Wiki-Explorer**: Eine Tree View direkt in der VS Code Activity Bar zeigt dir alle synchronisierten Wiki-Seiten und den Live-Status des Wikis direkt in deinem Editor an.
- 📚 **Bulk-Reservierung**: Du brauchst sofort 15 neue Pages für ein großes Feature? Der integrierte Wizard reserviert blitzschnell mehrere IDs am Stück im DevOps Wiki und kopiert sie dir direkt in die Zwischenablage.
- 🔢 **Freie Ranges & Lizenz-Management**: Verwalte eure freien Nummern-Bereiche direkt über IDSamurai! Die Extension kann eure lizenzierten Ranges einfach aus Lizenzdateien auslesen und überwachen, dass niemand außerhalb dieser Bereiche IDs vergibt.
- 🧹 **Smart Cleanup**: Du hast ein lokales Objekt gelöscht? IDSamurai merkt das sofort und fragt dich intelligent, ob die ID-Reservierung im Wiki wieder für deine Kollegen freigegeben werden soll.
- 🌿 **Git Branch Awareness**: Wenn du dir IDs über IDSamurai reservierst, taggt die Extension die reservierten Platzhalter im DevOps Wiki direkt mit deinem aktuellen Git-Branch (z.B. `feature-ticket-123`). Deine Kollegen sehen also sofort, wer woran arbeitet!
- 🧠 **Intelligente Diff-Engine**: Nutzt lokales Caching und ADO ETags, um nur die Seiten zu aktualisieren, die sich wirklich geändert haben (Optimistic Concurrency Control).

### 🛠️ Einrichtung & Konfiguration

1. **`.devops-wiki.json` erstellen**: Lege diese Datei im Root-Verzeichnis deines Workspaces an:
   ```json
   {
     "orgUrl": "https://dev.azure.com/DEINE-ORG",
     "project": "DEIN-PROJEKT",
     "wikiId": "DEIN-WIKI-NAME",
     "basePath": "/",
     "appSources": [
       {
         "appJson": "app.json",
         "srcPath": "src"
       }
     ]
   }
   ```
2. **PAT konfigurieren**: Führe den Command `IDSamurai: PAT konfigurieren` über die Command Palette (`Ctrl+Shift+P`) aus. Dein Personal Access Token (Scope: *Wiki Read & Write*) wird extrem sicher im VS Code SecretStorage abgelegt.
3. **Synchronisieren**: Lehne dich zurück. Sobald du eine Datei speicherst, synchronisiert IDSamurai sie im Hintergrund automatisch ins Wiki!

### 🚀 Commands

- `IDSamurai: Sync` - Startet die manuelle Synchronisierung (nur geänderte Objekte).
- `IDSamurai: Rebuild` - Löscht und erzwingt einen kompletten Neuaufbau aller Wiki-Seiten (mit Bestätigungsdialog).
- `IDSamurai: Bulk-Reservierung (Mehrere IDs)` - Reserviere mehrere IDs auf einen Schlag über den Wizard.
- `IDSamurai: PAT konfigurieren` - Hinterlegt das Personal Access Token sicher.

---

## 🇬🇧 English

**Your IDSamurai** effectively prevents object number conflicts across multiple developers. Object numbers are stored in a Wiki (like Azure DevOps Wiki), and when fetching a new object number, they are distributed straight from there. Instead of tedious manual Excel sheets, IDSamurai fully syncs your Wiki pages automatically with your AL source code in real-time. No more outdated documentation and no more ID collisions – your code is the single source of truth!

> [!NOTE]
> For development teams who are tired of documenting their objects in Excel. Designed for modern AL developers who need a seamless documentation pipeline straight from their code editor (VS Code).

### ✨ Highlights & Features

- 🛡️ **IntelliSense (Live Linter & Quick-Fix)**: The moment you type an Object ID that is already reserved by a colleague, IDSamurai immediately underlines the error live in your editor. One click (Alt+Enter) is enough, and IDSamurai suggests the next free ID straight from the Wiki and injects it into your code.
- 🌳 **Integrated Wiki Explorer**: A Tree View directly in the VS Code Activity Bar displays all synchronized Wiki pages and the live state of the Wiki right in your editor.
- 📚 **Bulk Reservation**: Need 15 new Pages for a large feature? The integrated wizard quickly reserves multiple IDs at once in the DevOps Wiki and copies them straight to your clipboard.
- 🔢 **Free Ranges & License Management**: Manage your free number ranges directly via IDSamurai! The extension can easily read your licensed ranges from license files and monitor that no one assigns IDs outside of these boundaries.
- 🧹 **Smart Cleanup**: Deleted a local object? IDSamurai notices immediately and intelligently asks if you want to release the ID reservation in the Wiki back to your colleagues.
- 🌿 **Git Branch Awareness**: Whenever you reserve IDs via IDSamurai, the extension tags the reserved placeholders in the DevOps Wiki directly with your current Git branch (e.g. `feature-ticket-123`). Your colleagues instantly see who is working on what!
- 🧠 **Intelligent Diff Engine**: Uses local caching and ADO ETags to update only the pages that have actually changed (Optimistic Concurrency Control).

### 🛠️ Setup & Configuration

1. **Create `.devops-wiki.json`**: Place this file in the root of your workspace:
   ```json
   {
     "orgUrl": "https://dev.azure.com/YOUR-ORG",
     "project": "YOUR-PROJECT",
     "wikiId": "YOUR-WIKI-NAME",
     "basePath": "/",
     "appSources": [
       {
         "appJson": "app.json",
         "srcPath": "src"
       }
     ]
   }
   ```
2. **Configure PAT**: Run the command `IDSamurai: PAT konfigurieren` from the Command Palette (`Ctrl+Shift+P`). Your Personal Access Token (Scope: *Wiki Read & Write*) is stored securely in the VS Code SecretStorage.
3. **Synchronize**: Sit back. The moment you save an AL file, IDSamurai syncs it into the Wiki in the background automatically!

### 🚀 Commands

- `IDSamurai: Sync` - Starts the manual synchronization (only changed objects).
- `IDSamurai: Rebuild` - Forces a complete rebuild of all Wiki pages (prompts for confirmation).
- `IDSamurai: Bulk-Reservierung (Mehrere IDs)` - Reserve multiple IDs at once via the Wizard.
- `IDSamurai: PAT konfigurieren` - Securely configure your Personal Access Token.

---
Built to boost developer productivity. **Happy coding, Samurai!**
