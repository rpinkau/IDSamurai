import { AlObject, AppRanges } from '../al-parser';
import { WikiClient } from '../wiki-client';
import { Config } from '../config';
import { parseSubPageName } from '../markdown-gen';

export async function findConsecutiveFreeBlock(
  type: string,
  count: number,
  localObjects: AlObject[],
  appRanges: AppRanges[],
  client: WikiClient,
  config: Config
): Promise<number[] | null> {
  const normalizedType = type.toLowerCase();
  
  // Hole Wiki-Seiten
  let wikiSubPages: any[] = [];
  try {
    wikiSubPages = await client.listSubPages(config.basePath);
  } catch (e) {
    // ignore
  }

  const wikiUsedIds = new Set<number>();
  for (const page of wikiSubPages) {
    const parsed = parseSubPageName(page.path);
    if (parsed && parsed.type === normalizedType) {
      wikiUsedIds.add(parsed.id);
    }
  }

  const localUsedIds = localObjects
    .filter(o => o.type.toLowerCase() === normalizedType)
    .map(o => o.id);
  
  const allUsedIds = new Set([...localUsedIds, ...wikiUsedIds]);

  for (const ar of appRanges) {
    const typeRanges = ar.ranges[normalizedType];
    if (!typeRanges) continue;

    for (const range of typeRanges) {
      let consecutiveCount = 0;
      let startId = -1;

      for (let id = range.from; id <= range.to; id++) {
        if (!allUsedIds.has(id)) {
          if (consecutiveCount === 0) startId = id;
          consecutiveCount++;
          
          if (consecutiveCount === count) {
            // Block gefunden!
            const block = [];
            for (let i = 0; i < count; i++) {
              block.push(startId + i);
            }
            return block;
          }
        } else {
          consecutiveCount = 0;
          startId = -1;
        }
      }
    }
  }

  return null;
}
