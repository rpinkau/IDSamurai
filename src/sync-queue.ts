import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from './config';
import { WikiClient } from './wiki-client';

export interface QueueJob {
  filePath: string;
  timestamp: number;
}

export class SyncQueue {
  private queueFilePath: string;
  private isProcessing = false;

  constructor(workspaceRoot: string) {
    const vscodeFolder = path.join(workspaceRoot, '.vscode');
    if (!fs.existsSync(vscodeFolder)) {
      fs.mkdirSync(vscodeFolder, { recursive: true });
    }
    this.queueFilePath = path.join(vscodeFolder, 'idsamurai-queue.json');
  }

  public getJobs(): QueueJob[] {
    if (!fs.existsSync(this.queueFilePath)) return [];
    try {
      const data = fs.readFileSync(this.queueFilePath, 'utf-8');
      return JSON.parse(data) as QueueJob[];
    } catch {
      return [];
    }
  }

  public addJob(filePath: string): void {
    const jobs = this.getJobs();
    // Vermeide Duplikate
    if (!jobs.some(j => j.filePath === filePath)) {
      jobs.push({ filePath, timestamp: Date.now() });
      fs.writeFileSync(this.queueFilePath, JSON.stringify(jobs, null, 2));
    }
  }

  public removeJob(filePath: string): void {
    if (!fs.existsSync(this.queueFilePath)) return;
    const jobs = this.getJobs();
    const updatedJobs = jobs.filter(j => j.filePath !== filePath);
    if (updatedJobs.length !== jobs.length) {
      if (updatedJobs.length === 0) {
        fs.unlinkSync(this.queueFilePath);
      } else {
        fs.writeFileSync(this.queueFilePath, JSON.stringify(updatedJobs, null, 2));
      }
    }
  }

  public getQueueCount(): number {
    return this.getJobs().length;
  }

  public async processQueue(
    config: Config,
    client: WikiClient,
    syncSingleFile: (filePath: string, config: Config, client: WikiClient) => Promise<boolean>
  ): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const jobs = this.getJobs();
      if (jobs.length === 0) return;

      for (const job of jobs) {
        if (!fs.existsSync(job.filePath)) {
          // Datei wurde gelöscht, ignorieren
          this.removeJob(job.filePath);
          continue;
        }

        try {
          // Versuche zu synchronisieren
          const success = await syncSingleFile(job.filePath, config, client);
          if (success) {
            this.removeJob(job.filePath);
          }
        } catch (e: any) {
          // Wenn es wieder am Netzwerk scheitert, abbrechen
          if (isNetworkError(e)) {
            break;
          } else {
            // Ein anderer Fehler (z.B. Parse Fehler), Job trotzdem löschen
            this.removeJob(job.filePath);
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

export function isNetworkError(error: any): boolean {
  if (!error) return false;
  const str = String(error).toLowerCase();
  return str.includes('fetch failed') || str.includes('econnrefused') || str.includes('enotfound') || str.includes('timeout');
}
