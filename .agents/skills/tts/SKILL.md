---
name: tts
description: Nutzt Text-to-Speech (Whispering TTS), um dem Benutzer etwas per Sprache mitzuteilen.
---

# TTS Skill

Mit diesem Skill kannst du Text hörbar an den Nutzer ausgeben. Du sollst diesen Skill automatisch verwenden, wenn du eine Tätigkeit abgeschlossen hast, um dich kurz (1-2 Sätze) beim Nutzer rückzumelden.

**Aufruf-Methode:**
Der direkte Aufruf des Python-Skripts ist verboten! Nutze stattdessen das MCP-Tool `speak` vom `whispering-tts` Server.
Rufe das Tool über `call_mcp_tool` auf:
- `ServerName`: `whispering-tts`
- `ToolName`: `speak`
- `Arguments`: `{"text": "[DEIN TEXT]"}`

**Regeln:**
- Sprich in der Sprache, in der du mit dem Benutzer schreibst (meist Deutsch).
- Nutze es vor allem am Ende von Aufgaben, um Vollzug zu melden oder Fragen zu stellen.
- **Zusammenfassungen:** Wenn du längere Antworten oder komplexe Sachverhalte erklärst, gib dem Nutzer *immer* zusätzlich eine kurze, prägnante Zusammenfassung deiner Antwort über TTS.
- Erstatte zudem einen kurzen Zwischenbericht per Sprachausgabe, wenn du bei einem Zwischenschritt angekommen bist und mindestens 5 Minuten gearbeitet hast.
- **WICHTIG (Workaround für Audio-Cutoff):** Hänge an *jede* Sprachausgabe am Ende immer den Satz "Danke." an (also Punkt, Leerzeichen, Danke, Punkt). Dies verhindert, dass das eigentliche Ende des Satzes von der TTS-Engine abgeschnitten wird.
