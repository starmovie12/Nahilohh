export const maxDuration = 60;
export const dynamic = 'force-dynamic';

import { db } from '@/lib/firebaseAdmin';
import {
  extractMovieLinks,
  extractMoviePreview,
  extractMovieMetadata,
  solveHBLinks,
  solveHubCDN,
  solveHubDrive,
  solveHubCloudNative,
} from '@/lib/solvers';

const API_MAP = {
  timer: 'http://85.121.5.246:10000/solve?url=',
};

const fetchWithUA = (url: string, options: any = {}) => {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
};

// =============================================
// Solve a single download link end-to-end
// =============================================
async function solveSingleLink(
  originalLink: string,
  sendLog: (msg: string, type: string) => void
): Promise<{ status: string; finalLink?: string; buttonName?: string; error?: string }> {
  let currentLink = originalLink;

  try {
    // --- HUBCDN.FANS BYPASS ---
    if (currentLink.includes('hubcdn.fans')) {
      sendLog('⚡ HubCDN Detected! Processing...', 'info');
      const r = await solveHubCDN(currentLink);
      if (r.status === 'success') {
        sendLog('🎉 Direct Link Found via HubCDN', 'success');
        return { status: 'done', finalLink: r.final_link };
      }
      return { status: 'error', error: r.message || 'HubCDN failed' };
    }

    // --- TIMER BYPASS ---
    const targetDomains = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud'];
    let loopCount = 0;

    while (loopCount < 3 && !targetDomains.some((d) => currentLink.includes(d))) {
      const isTimerPage = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'].some((x) =>
        currentLink.includes(x)
      );
      if (!isTimerPage && loopCount === 0) break;

      sendLog('⏳ Timer Bypass...', 'warn');
      try {
        const r = await fetchWithUA(API_MAP.timer + encodeURIComponent(currentLink)).then((res) =>
          res.json()
        );
        if (r.status === 'success') {
          currentLink = r.extracted_link!;
          sendLog('✅ Timer Bypassed', 'success');
        } else {
          throw new Error(r.message || 'Timer failed');
        }
      } catch (e: any) {
        sendLog(`❌ Timer Error: ${e.message}`, 'error');
        break;
      }
      loopCount++;
    }

    // --- HBLINKS ---
    if (currentLink.includes('hblinks')) {
      sendLog('🔗 Solving HBLinks...', 'info');
      const r = await solveHBLinks(currentLink);
      if (r.status === 'success') {
        currentLink = r.link!;
        sendLog('✅ HBLinks Solved', 'success');
      } else {
        return { status: 'error', error: r.message || 'HBLinks failed' };
      }
    }

    // --- HUBDRIVE ---
    if (currentLink.includes('hubdrive')) {
      sendLog('☁️ Solving HubDrive...', 'info');
      const r = await solveHubDrive(currentLink);
      if (r.status === 'success') {
        currentLink = r.link!;
        sendLog('✅ HubDrive Solved', 'success');
      } else {
        return { status: 'error', error: r.message || 'HubDrive failed' };
      }
    }

    // --- HUBCLOUD ---
    if (currentLink.includes('hubcloud') || currentLink.includes('hubcdn')) {
      sendLog('⚡ Getting Direct Link (HubCloud)...', 'info');
      const r = await solveHubCloudNative(currentLink);
      if (r.status === 'success' && r.best_download_link) {
        sendLog(`🎉 Direct Link via ${r.best_button_name || 'HubCloud'}`, 'success');
        return {
          status: 'done',
          finalLink: r.best_download_link,
          buttonName: r.best_button_name,
        };
      }
      return { status: 'error', error: r.message || 'HubCloud failed' };
    }

    return { status: 'error', error: 'Unrecognized link format' };
  } catch (e: any) {
    return { status: 'error', error: e.message };
  }
}

// =============================================
// POST /api/auto-process — Process ONE queue item
// =============================================
export async function POST(req: Request) {
  const encoder = new TextEncoder();

  let queueId: string;
  let collection: string;
  let sourceUrl: string;
  let title: string;
  let queueType: string;

  try {
    const body = await req.json();
    queueId = body.queueId;
    collection = body.collection;
    sourceUrl = body.url;
    title = body.title || 'Unknown';
    queueType = body.type || 'movie';
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!queueId || !collection || !sourceUrl) {
    return new Response(
      JSON.stringify({ error: 'queueId, collection, and url are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Use streaming for live progress
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
        } catch {
          // stream closed
        }
      };

      try {
        // Mark as processing in queue
        await db.collection(collection).doc(queueId).update({
          status: 'processing',
          updatedAt: new Date().toISOString(),
        });

        // ==================== STEP 1: Extract links from page ====================
        send({ step: 'extract', msg: `🔍 Scraping page: ${title}...`, type: 'info' });

        const extractResult = await extractMovieLinks(sourceUrl);

        if (extractResult.status !== 'success' || !extractResult.links || extractResult.links.length === 0) {
          const errMsg = extractResult.message || 'No download links found on page';
          send({ step: 'extract', msg: `❌ ${errMsg}`, type: 'error' });

          // Mark as failed in queue
          await db.collection(collection).doc(queueId).update({
            status: 'failed',
            error: errMsg,
            updatedAt: new Date().toISOString(),
          });

          send({ step: 'done', status: 'failed', error: errMsg });
          controller.close();
          return;
        }

        const links = extractResult.links;
        const metadata = extractResult.metadata;
        const preview = extractResult.preview;
        const totalLinks = links.length;

        send({
          step: 'extract',
          msg: `✅ Found ${totalLinks} download links. Preview: ${preview?.title || title}`,
          type: 'success',
          preview,
          metadata,
          totalLinks,
        });

        // ==================== STEP 2: Solve each link ====================
        send({ step: 'solve', msg: `⚡ Resolving ${totalLinks} links...`, type: 'info' });

        const resolvedLinks: any[] = [];

        for (let i = 0; i < links.length; i++) {
          const linkData = links[i];
          send({
            step: 'solve',
            msg: `🔗 [${i + 1}/${totalLinks}] Solving: ${linkData.name}`,
            type: 'info',
            progress: { current: i + 1, total: totalLinks },
          });

          const result = await solveSingleLink(linkData.link, (msg, type) => {
            send({ step: 'solve', msg: `   ↳ ${msg}`, type, linkIndex: i });
          });

          resolvedLinks.push({
            name: linkData.name,
            originalLink: linkData.link,
            finalLink: result.finalLink || null,
            buttonName: result.buttonName || null,
            status: result.status,
            error: result.error || null,
          });

          if (result.status === 'done') {
            send({
              step: 'solve',
              msg: `✅ [${i + 1}/${totalLinks}] ${linkData.name} → SOLVED`,
              type: 'success',
            });
          } else {
            send({
              step: 'solve',
              msg: `❌ [${i + 1}/${totalLinks}] ${linkData.name} → FAILED: ${result.error}`,
              type: 'error',
            });
          }
        }

        const successfulLinks = resolvedLinks.filter((l) => l.status === 'done');
        const failedLinks = resolvedLinks.filter((l) => l.status !== 'done');

        send({
          step: 'solve',
          msg: `📊 Results: ${successfulLinks.length} solved, ${failedLinks.length} failed out of ${totalLinks}`,
          type: successfulLinks.length > 0 ? 'success' : 'error',
        });

        if (successfulLinks.length === 0) {
          send({ step: 'save', msg: '❌ No links resolved. Skipping save.', type: 'error' });

          await db.collection(collection).doc(queueId).update({
            status: 'failed',
            error: 'All download links failed to resolve',
            updatedAt: new Date().toISOString(),
          });

          send({ step: 'done', status: 'failed', error: 'All links failed' });
          controller.close();
          return;
        }

        // ==================== STEP 3: Save to main database ====================
        send({ step: 'save', msg: '💾 Saving to main database...', type: 'info' });

        // Determine target collection based on type
        const mainCollection = queueType === 'webseries' ? 'webseries' : 'movies';

        // Build the document for the main database
        const movieDoc: Record<string, any> = {
          title: preview?.title || title,
          posterUrl: preview?.posterUrl || null,
          sourceUrl: sourceUrl,
          quality: metadata?.quality || 'Unknown',
          languages: metadata?.languages || 'Not Specified',
          audioLabel: metadata?.audioLabel || 'Unknown',
          type: queueType,
          downloadLinks: successfulLinks.map((l) => ({
            name: l.name,
            link: l.finalLink,
            buttonName: l.buttonName,
          })),
          allLinks: resolvedLinks, // Keep full data for reference
          totalLinks: totalLinks,
          successfulLinks: successfulLinks.length,
          failedLinks: failedLinks.length,
          status: 'active',
          createdAt: new Date().toISOString(),
          autoProcessed: true,
          queueRef: {
            id: queueId,
            collection: collection,
          },
        };

        const savedRef = await db.collection(mainCollection).add(movieDoc);

        send({
          step: 'save',
          msg: `✅ Saved to "${mainCollection}" collection (ID: ${savedRef.id})`,
          type: 'success',
          savedId: savedRef.id,
          savedCollection: mainCollection,
        });

        // ==================== STEP 4: Update queue status ====================
        send({ step: 'complete', msg: '🔄 Updating queue status...', type: 'info' });

        await db.collection(collection).doc(queueId).update({
          status: 'completed',
          processedAt: new Date().toISOString(),
          savedTo: { collection: mainCollection, id: savedRef.id },
          updatedAt: new Date().toISOString(),
        });

        send({
          step: 'complete',
          msg: `🎉 "${preview?.title || title}" fully processed and saved!`,
          type: 'success',
        });

        send({
          step: 'done',
          status: 'completed',
          savedId: savedRef.id,
          savedCollection: mainCollection,
          title: preview?.title || title,
          successfulLinks: successfulLinks.length,
          failedLinks: failedLinks.length,
        });

      } catch (e: any) {
        console.error('[auto-process] Critical error:', e.message);
        send({ step: 'done', status: 'failed', error: e.message });

        // Try to mark queue item as failed
        try {
          await db.collection(collection).doc(queueId).update({
            status: 'failed',
            error: e.message,
            updatedAt: new Date().toISOString(),
          });
        } catch {}
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
