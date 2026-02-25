export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';

// =============================================
// GET — Fetch all pending items from both queues
// =============================================
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const queueType = searchParams.get('type') || 'all'; // 'movies', 'webseries', or 'all'

  try {
    const results: any[] = [];

    const fetchQueue = async (collectionName: string, label: string) => {
      const snapshot = await db
        .collection(collectionName)
        .where('status', '==', 'pending')
        .orderBy('__name__') // deterministic order
        .get();

      snapshot.docs.forEach((doc) => {
        results.push({
          id: doc.id,
          collection: collectionName,
          type: label,
          ...doc.data(),
        });
      });
    };

    if (queueType === 'movies' || queueType === 'all') {
      await fetchQueue('movies_queue', 'movie');
    }
    if (queueType === 'webseries' || queueType === 'all') {
      await fetchQueue('webseries_queue', 'webseries');
    }

    return NextResponse.json({
      status: 'success',
      total: results.length,
      items: results,
    });
  } catch (e: any) {
    console.error('[GET /api/auto-process/queue] Error:', e.message);
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}

// =============================================
// PATCH — Update a queue item's status
// =============================================
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { id, collection, status, error: errorMsg } = body;

    if (!id || !collection || !status) {
      return NextResponse.json(
        { status: 'error', message: 'id, collection, and status are required' },
        { status: 400 }
      );
    }

    const updateData: any = {
      status,
      updatedAt: new Date().toISOString(),
    };
    if (errorMsg) updateData.error = errorMsg;

    await db.collection(collection).doc(id).update(updateData);

    return NextResponse.json({ status: 'success', id, newStatus: status });
  } catch (e: any) {
    console.error('[PATCH /api/auto-process/queue] Error:', e.message);
    return NextResponse.json({ status: 'error', message: e.message }, { status: 500 });
  }
}
