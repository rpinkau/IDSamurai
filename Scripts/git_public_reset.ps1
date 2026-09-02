# PowerShell Skript zum kompletten Zurücksetzen des Git-Repositories
# ACHTUNG: Dies löscht die lokale Git-Historie und überschreibt die GitHub-Historie!

Set-Location -Path "C:\GIT\IDSamurai"

Write-Host "1. Lösche lokalen .git Ordner..." -ForegroundColor Yellow
if (Test-Path ".git") {
    Remove-Item -Path ".git" -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "2. Initialisiere neues Git-Repository..." -ForegroundColor Yellow
git init
git branch -m main

Write-Host "3. Füge Dateien hinzu und erstelle initialen Commit (Main-Branch)..." -ForegroundColor Yellow
git add .
git commit -m "Initial public release"

Write-Host "4. Verbinde mit GitHub Remote..." -ForegroundColor Yellow
git remote add origin "https://github.com/rpinkau/IDSamurai"

Write-Host "5. Lade Main-Branch auf GitHub hoch (Force-Push)..." -ForegroundColor Yellow
git push -u origin main -f

Write-Host "6. Erstelle Dev-Branch und lade ihn hoch..." -ForegroundColor Yellow
git checkout -b dev
git push -u origin dev -f

Write-Host "Fertig! Das Repository wurde mit Main- und Dev-Branch zurückgesetzt und auf GitHub überschrieben." -ForegroundColor Green
