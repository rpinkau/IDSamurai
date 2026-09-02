# Config-Suche bei "Open Folder" erweitern

Die in `src/config.ts` geplante Sucherweiterung (Suche im aktuellen Ordner und aufwärts, auch ohne Git) wurde bereits implementiert. `loadConfig()` sucht nun zuerst im Git-Root und anschließend als Fallback aufwärts vom Workspace-Folder.
