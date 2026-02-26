'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bolt, Link as LinkIcon, Rocket, Loader2, RotateCcw, AlertTriangle, CircleCheck, History, ChevronRight, ChevronDown, Video, Film, Globe, Volume2, Sparkles, Home, Clock, CheckCircle2, XCircle, Trash2, RefreshCw, ExternalLink, Bot, StopCircle, ListVideo } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import LinkCard from '@/components/LinkCard';

interface LogEntry {
  msg: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

interface Task {
  id: string;
  url: string;
  status: 'processing' | 'completed' | 'failed';
  createdAt: string;
  links: any[];
  error?: string;
  preview?: {
    title: string;
    posterUrl: string | null;
  };
  metadata?: {
    quality: string;
    languages: string;
    audioLabel: string;
  };
}

type TabType = 'home' | 'processing' | 'completed' | 'failed' | 'history';

function formatTime12h(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return isoString;
  }
}

function getLinkStats(links: any[]): { total: number; done: number; failed: number; pending: number } {
  if (!links || links.length === 0) return { total: 0, done: 0, failed: 0, pending: 0 };
  let done = 0, failed = 0, pending = 0;
  for (const link of links) {
    const s = (link.status || '').toLowerCase();
    if (s === 'done' || s === 'success') done++;
    else if (s === 'error' || s === 'failed') failed++;
    else pending++;
  }
  return { total: links.length, done, failed, pending };
}

export default function MflixApp() {
  const [url, setUrl] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<TabType>('home');

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<Record<number, LogEntry[]>>({});
  const [liveLinks, setLiveLinks] = useState<Record<number, string | null>>({});
  const [liveStatuses, setLiveStatuses] = useState<Record<number, string>>({});

  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);

  // =========================================================================
  // AUTO-PILOT STATE & REFS
  // =========================================================================
  const [isAutoPilot, setIsAutoPilot] = useState(false);
  const [autoPilotQueue, setAutoPilotQueue] = useState<string[]>([]);
  const [autoPilotStatus, setAutoPilotStatus] = useState<string>('');
  const [autoPilotProcessed, setAutoPilotProcessed] = useState(0);
  const [autoPilotTotal, setAutoPilotTotal] = useState(0);
  const autoPilotActiveRef = useRef(false);
  const autoPilotQueueRef = useRef<string[]>([]);

  const streamStartedRef = useRef<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const completedLinksRef = useRef<Record<string, Record<number, any>>>({});
  const streamEndedAtRef = useRef<Record<string, number>>({});

  useEffect(() => {
    fetchTasks();
    pollRef.current = setInterval(fetchTasks, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) return;
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) return;
      const data = await res.json();
      
      if (Array.isArray(data)) {
        setTasks(prevTasks => {
          const currentlyStreamingIds = streamStartedRef.current;
          const now = Date.now();

          return data.map((serverTask: Task) => {
            if (currentlyStreamingIds.has(serverTask.id)) {
              const localTask = prevTasks.find(t => t.id === serverTask.id);
              if (localTask) return localTask;
            }

            const endedAt = streamEndedAtRef.current[serverTask.id];
            const isRecentlyEnded = endedAt && (now - endedAt < 15000);
            const shieldData = completedLinksRef.current[serverTask.id] || {};
            
            const mergedLinks = (serverTask.links || []).map((fbLink: any, idx: number) => {
              const protectedLink = shieldData[idx];
              if (protectedLink) {
                const fbStatus = (fbLink.status || '').toLowerCase();
                const isFbPending = fbStatus === 'pending' || fbStatus === 'processing' || fbStatus === '';
                if (isFbPending || isRecentlyEnded) {
                  return {
                    ...fbLink,
                    status: protectedLink.status,
                    finalLink: protectedLink.finalLink || fbLink.finalLink,
                    best_button_name: protectedLink.best_button_name || fbLink.best_button_name,
                    logs: protectedLink.logs || fbLink.logs,
                  };
                }
              }
              return fbLink;
            });

            const allDone = mergedLinks.length > 0 && mergedLinks.every((l: any) => {
              const s = (l.status || '').toLowerCase();
              return s === 'done' || s === 'success' || s === 'error' || s === 'failed';
            });
            const anySuccess = mergedLinks.some((l: any) => {
              const s = (l.status || '').toLowerCase();
              return s === 'done' || s === 'success';
            });
            
            let newTaskStatus = serverTask.status;
            if (allDone) newTaskStatus = anySuccess ? 'completed' : 'failed';
            else if (isRecentlyEnded) newTaskStatus = 'processing';

            return { ...serverTask, status: newTaskStatus, links: mergedLinks };
          });
        });
      }
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    }
  };

  const getEffectiveStats = useCallback((task: Task): { total: number; done: number; failed: number; pending: number } => {
    const isLive = activeTaskId === task.id;
    const shieldData = completedLinksRef.current[task.id] || {};
    
    const total = task.links?.length || 0;
    let done = 0, failed = 0, pending = 0;

    for (let i = 0; i < total; i++) {
      let status = '';
      if (isLive && liveStatuses[i]) {
        status = liveStatuses[i];
      } else if (shieldData[i]) {
        status = shieldData[i].status;
      } else {
        status = task.links[i]?.status || '';
      }

      status = status.toLowerCase();
      if (status === 'done' || status === 'success') done++;
      else if (status === 'error' || status === 'failed') failed++;
      else pending++;
    }

    return { total, done, failed, pending };
  }, [activeTaskId, liveStatuses]);

  const getTrueTaskStatus = (task: Task, stats: { total: number; done: number; failed: number; pending: number }) => {
    if (activeTaskId === task.id) return 'processing';
    if (stats.total > 0 && stats.pending === 0) {
      return stats.done > 0 ? 'completed' : 'failed';
    }
    return task.status;
  };

  const startLiveStream = useCallback(async (taskId: string, links: any[]) => {
    if (streamStartedRef.current.has(taskId)) return;

    const shieldData = completedLinksRef.current[taskId] || {};
    const pendingLinks = links
      .map((l: any, idx: number) => ({ ...l, _originalIdx: idx }))
      .filter((l: any) => {
        if (shieldData[l._originalIdx]) return false;
        const s = (l.status || '').toLowerCase();
        return s === 'pending' || s === 'processing' || s === '';
      });

    if (pendingLinks.length === 0) return;

    streamStartedRef.current.add(taskId);
    setActiveTaskId(taskId);
    
    if (!completedLinksRef.current[taskId]) {
      completedLinksRef.current[taskId] = {};
    }

    const initialLogs: Record<number, LogEntry[]> = {};
    const initialLinks: Record<number, string | null> = {};
    const initialStatuses: Record<number, string> = {};

    links.forEach((link: any, idx: number) => {
      if (shieldData[idx]) {
        initialLogs[idx] = shieldData[idx].logs || [];
        initialLinks[idx] = shieldData[idx].finalLink || null;
        initialStatuses[idx] = shieldData[idx].status;
      } else {
        const s = (link.status || '').toLowerCase();
        if (s === 'done' || s === 'success') {
          initialLogs[idx] = link.logs || [];
          initialLinks[idx] = link.finalLink || null;
          initialStatuses[idx] = 'done';
          completedLinksRef.current[taskId][idx] = { status: 'done', finalLink: link.finalLink, logs: link.logs };
        } else if (s === 'error' || s === 'failed') {
          initialLogs[idx] = [{ msg: '🔄 Retrying...', type: 'info' }];
          initialLinks[idx] = null;
          initialStatuses[idx] = 'processing';
        } else {
          initialLogs[idx] = [];
          initialLinks[idx] = null;
          initialStatuses[idx] = 'processing';
        }
      }
    });

    setLiveLogs(initialLogs);
    setLiveLinks(initialLinks);
    setLiveStatuses(initialStatuses);

    try {
      const linksToSend = pendingLinks.map((l: any) => ({
        id: l._originalIdx,
        name: l.name,
        link: l.link,
      }));

      const response = await fetch('/api/stream_solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: linksToSend, taskId })
      });

      if (!response.ok) {
        setLiveStatuses(prev => {
          const updated = { ...prev };
          pendingLinks.forEach((l: any) => { updated[l._originalIdx] = 'error'; });
          return updated;
        });
        return;
      }

      if (!response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const lid = data.id;

            if (data.msg && data.type) {
              setLiveLogs(prev => ({
                ...prev,
                [lid]: [...(prev[lid] || []), { msg: data.msg, type: data.type }]
              }));
            }

            if (data.final) {
              setLiveLinks(prev => ({ ...prev, [lid]: data.final }));
            }

            if (data.status === 'done' || data.status === 'error') {
              setLiveStatuses(prev => ({ ...prev, [lid]: data.status }));
              setLiveLogs(currentLogs => {
                setLiveLinks(currentLinks => {
                  completedLinksRef.current[taskId][lid] = {
                    status: data.status,
                    finalLink: data.final || currentLinks[lid],
                    best_button_name: data.best_button_name,
                    logs: currentLogs[lid] || []
                  };
                  return currentLinks;
                });
                return currentLogs;
              });
            }

            if (data.status === 'finished') {
              setLiveStatuses(prev => {
                const currentStatus = prev[lid];
                if (currentStatus !== 'done' && currentStatus !== 'error') {
                  completedLinksRef.current[taskId][lid] = { status: 'error', logs: [] };
                  return { ...prev, [lid]: 'error' };
                }
                return prev;
              });
            }
          } catch { }
        }
      }
    } catch (e: any) {
      console.error('[Stream] Stream error:', e);
    } finally {
      streamStartedRef.current.delete(taskId);
      streamEndedAtRef.current[taskId] = Date.now();
      setTimeout(fetchTasks, 1000);
      setActiveTaskId(null);
    }
  }, []);

  // =========================================================================
  // AUTO-PILOT CORE LOGIC
  // =========================================================================

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const fetchPendingQueue = async (): Promise<string[]> => {
    try {
      // Try dedicated auto-process queue endpoint first
      const res = await fetch('/api/auto-process/queue');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.urls) && data.urls.length > 0) return data.urls;
        if (Array.isArray(data) && data.length > 0) return data;
      }
    } catch {}

    // Fallback: extract pending/failed task URLs from existing tasks list
    try {
      const res = await fetch('/api/tasks');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          return data
            .filter((t: Task) => t.status === 'failed' || t.status === 'processing')
            .map((t: Task) => t.url);
        }
      }
    } catch {}

    return [];
  };

  const processUrlAutoPilot = async (targetUrl: string): Promise<void> => {
    const trimmedUrl = targetUrl.trim();
    if (!trimmedUrl) return;

    const normalizeUrl = (u: string) =>
      u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

    const existingTask = tasks.find(t => normalizeUrl(t.url) === normalizeUrl(trimmedUrl));
    if (existingTask && getTrueTaskStatus(existingTask, getEffectiveStats(existingTask)) === 'completed') {
      return; // skip already completed
    }

    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl }),
      });

      if (!response.ok) return;
      const data = await response.json();
      if (data.error) return;

      await fetchTasks();

      if (data.taskId) {
        setExpandedTask(data.taskId);
        setActiveTab('processing');
        completedLinksRef.current[data.taskId] = {};

        try {
          const taskRes = await fetch('/api/tasks');
          if (taskRes.ok) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);
            if (newTask?.links?.length > 0) {
              await startLiveStream(data.taskId, newTask.links);
            }
          }
        } catch {}
      }
    } catch {}
  };

  const startAutoPilot = async () => {
    setAutoPilotStatus('⏳ Fetching pending URLs...');
    setAutoPilotProcessed(0);

    const queue = await fetchPendingQueue();

    if (queue.length === 0) {
      setAutoPilotStatus('✅ Queue is empty — nothing to process!');
      setIsAutoPilot(false);
      autoPilotActiveRef.current = false;
      return;
    }

    autoPilotQueueRef.current = [...queue];
    setAutoPilotQueue([...queue]);
    setAutoPilotTotal(queue.length);
    setAutoPilotStatus(`🚀 Starting Auto-Pilot — ${queue.length} URLs in queue`);

    let processed = 0;
    for (const queuedUrl of queue) {
      if (!autoPilotActiveRef.current) {
        setAutoPilotStatus('🛑 Auto-Pilot stopped by user.');
        break;
      }

      setUrl(queuedUrl);
      setAutoPilotStatus(`⚡ Processing (${processed + 1}/${queue.length}): ${queuedUrl.slice(0, 50)}...`);

      await processUrlAutoPilot(queuedUrl);

      processed++;
      setAutoPilotProcessed(processed);

      if (!autoPilotActiveRef.current) {
        setAutoPilotStatus('🛑 Auto-Pilot stopped by user.');
        break;
      }

      if (processed < queue.length) {
        setAutoPilotStatus(`✅ Done (${processed}/${queue.length}) — Waiting 3s before next...`);
        await sleep(3000);
      }
    }

    if (autoPilotActiveRef.current) {
      setAutoPilotStatus(`🎉 Auto-Pilot complete! Processed ${processed} URL${processed !== 1 ? 's' : ''}.`);
    }

    autoPilotActiveRef.current = false;
    setIsAutoPilot(false);
    setUrl('');
  };

  const handleToggleAutoPilot = () => {
    if (isAutoPilot) {
      // STOP
      autoPilotActiveRef.current = false;
      setIsAutoPilot(false);
    } else {
      // START
      autoPilotActiveRef.current = true;
      setIsAutoPilot(true);
      setAutoPilotQueue([]);
      setAutoPilotTotal(0);
      setAutoPilotProcessed(0);
      startAutoPilot();
    }
  };

  const startProcess = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;

    // =========================================================================
    // SMART URL NORMALIZER: Ignores http/https, www, and trailing slashes
    // =========================================================================
    const normalizeUrl = (u: string) => {
      return u.toLowerCase()
              .replace(/^https?:\/\//, '')
              .replace(/^www\./, '')
              .replace(/\/$/, ''); // removes slash at the end
    };

    const targetUrl = normalizeUrl(trimmedUrl);
    
    // Check if this EXACT movie already exists in our tasks
    const existingTask = tasks.find(t => normalizeUrl(t.url) === targetUrl);

    if (existingTask) {
      const trueStatus = getTrueTaskStatus(existingTask, getEffectiveStats(existingTask));

      if (trueStatus === 'completed') {
        setError("✅ Yeh movie pehle se hi nikal chuki hai! Niche open kar di gayi hai.");
        setExpandedTask(existingTask.id);
        setActiveTab('completed'); // Redirects user to completed tab
        setUrl('');
        return;
      }

      if (trueStatus === 'processing') {
        setError("⏳ Yeh movie already process ho rahi hai! Niche check karein.");
        setExpandedTask(existingTask.id);
        setActiveTab('processing'); // Redirects user to processing tab
        setUrl('');
        return;
      }
    }

    setIsConnecting(true);
    setError(null);
    setIsDone(false);

    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl })
      });

      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error);

      setIsConnecting(false);
      setIsProcessing(true);

      await fetchTasks();

      if (data.taskId) {
        setExpandedTask(data.taskId);
        setActiveTab('processing');
        completedLinksRef.current[data.taskId] = {};

        try {
          const taskRes = await fetch('/api/tasks');
          if (taskRes.ok) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);
            if (newTask?.links?.length > 0) {
              await startLiveStream(data.taskId, newTask.links);
            }
          }
        } catch (e) {}
      }

      setUrl('');
      setIsProcessing(false);
      setIsDone(true);
      setTimeout(() => setIsDone(false), 3000);

    } catch (err: any) {
      setError(err.message || 'An error occurred');
      setIsConnecting(false);
      setIsProcessing(false);
    }
  };

  const handleDeleteTask = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingTaskId) return;

    setDeletingTaskId(taskId);
    try {
      const res = await fetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!res.ok) throw new Error('Failed to delete');

      setTasks(prev => prev.filter(t => t.id !== taskId));
      if (expandedTask === taskId) setExpandedTask(null);
      
      delete completedLinksRef.current[taskId];
      delete streamEndedAtRef.current[taskId];
    } catch (err: any) {
      setError(`Delete failed: ${err.message}`);
    } finally {
      setDeletingTaskId(null);
    }
  };

  const handleRetryTask = async (task: Task, e: React.MouseEvent) => {
    e.stopPropagation();
    if (retryingTaskId) return;

    setRetryingTaskId(task.id);
    try {
      await fetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      delete completedLinksRef.current[task.id];
      delete streamEndedAtRef.current[task.id];

      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: task.url }),
      });

      if (!response.ok) throw new Error(`Server error`);
      const data = await response.json();
      
      await fetchTasks();

      if (data.taskId) {
        setExpandedTask(data.taskId);
        setActiveTab('processing');
        try {
          const taskRes = await fetch('/api/tasks');
          if (taskRes.ok) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);
            if (newTask?.links?.length > 0) {
              await startLiveStream(data.taskId, newTask.links);
            }
          }
        } catch (e) {}
      }
    } catch (err: any) {
      setError(`Retry failed: ${err.message}`);
    } finally {
      setRetryingTaskId(null);
    }
  };

  const getEffectiveLinkData = (task: Task, linkIdx: number, link: any) => {
    const isLive = activeTaskId === task.id;
    const shield = completedLinksRef.current[task.id]?.[linkIdx];
    
    if (isLive && liveStatuses[linkIdx]) {
      return { logs: liveLogs[linkIdx] || [], finalLink: liveLinks[linkIdx] || null, status: liveStatuses[linkIdx] };
    }
    if (shield) {
      return { logs: shield.logs || [], finalLink: shield.finalLink || link.finalLink || null, status: shield.status };
    }
    return { logs: link.logs || [], finalLink: link.finalLink || null, status: link.status || 'processing' };
  };

  const getFilteredTasks = (): Task[] => {
    switch (activeTab) {
      case 'processing': return tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'processing');
      case 'completed': return tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'completed');
      case 'failed': return tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'failed');
      case 'history': return [...tasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      case 'home': default: return tasks;
    }
  };

  const filteredTasks = getFilteredTasks();
  const tabLabels: Record<TabType, string> = { home: 'Home', processing: 'Processing', completed: 'Completed', failed: 'Failed', history: 'History' };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 pb-28">
      <header className="flex justify-between items-center mb-8">
        <div className="text-2xl font-bold bg-gradient-to-br from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
          <Bolt className="text-indigo-500 fill-indigo-500" />
          MFLIX PRO
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          LIVE ENGINE
        </div>
      </header>

      {activeTab === 'home' && (
        <section className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-6 mb-8 shadow-2xl">
          <div className="relative mb-4">
            <LinkIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5" />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && startProcess()}
              placeholder="Paste Movie URL here..."
              className="w-full bg-black/40 border border-white/10 text-white pl-12 pr-4 py-4 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 transition-all font-sans"
            />
          </div>

          <button
            onClick={startProcess}
            disabled={isConnecting || isProcessing || isDone}
            className={`w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-300 shadow-lg active:scale-95 ${
              isDone ? 'bg-emerald-500 text-white' : error ? 'bg-rose-500 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:opacity-70'
            }`}
          >
            {isConnecting ? <><Loader2 className="w-5 h-5 animate-spin" />CONNECTING...</> : 
             isProcessing ? <><RotateCcw className="w-5 h-5 animate-spin" />PROCESSING LIVE...</> : 
             isDone ? <><CircleCheck className="w-5 h-5" />ALL DONE ✅</> : 
             error ? <><AlertTriangle className="w-5 h-5" />ERROR</> : 
             <><Rocket className="w-5 h-5" />START ENGINE</>}
          </button>

          {error && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
              <p className="flex-1">{error}</p>
              <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-emerald-300">Dismiss</button>
            </motion.div>
          )}

          {/* ================================================================ */}
          {/* AUTO-PILOT SECTION                                               */}
          {/* ================================================================ */}
          <div className="mt-4 border border-dashed border-white/10 rounded-2xl p-4 bg-black/20">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Bot className={`w-5 h-5 ${isAutoPilot ? 'text-violet-400 animate-pulse' : 'text-slate-500'}`} />
                <div>
                  <p className="text-xs font-bold text-slate-300 uppercase tracking-wider">Auto-Pilot Mode</p>
                  <p className="text-[10px] text-slate-500">Automatically processes all pending URLs from queue</p>
                </div>
              </div>
              <button
                onClick={handleToggleAutoPilot}
                disabled={isConnecting || isProcessing}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm transition-all active:scale-95 disabled:opacity-50 ${
                  isAutoPilot
                    ? 'bg-rose-500/20 border border-rose-500/40 text-rose-400 hover:bg-rose-500/30'
                    : 'bg-violet-600/20 border border-violet-500/40 text-violet-400 hover:bg-violet-600/30'
                }`}
              >
                {isAutoPilot ? (
                  <><StopCircle className="w-4 h-4" />Stop</>
                ) : (
                  <><Bot className="w-4 h-4" />Start</>
                )}
              </button>
            </div>

            <AnimatePresence>
              {(isAutoPilot || autoPilotStatus) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 overflow-hidden"
                >
                  {/* Status bar */}
                  <div className="flex items-center gap-2 bg-black/30 rounded-xl px-3 py-2.5 mb-2">
                    {isAutoPilot && <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin flex-shrink-0" />}
                    <p className="text-[11px] text-slate-300 font-mono truncate">{autoPilotStatus}</p>
                  </div>

                  {/* Progress bar */}
                  {autoPilotTotal > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                        <span className="flex items-center gap-1"><ListVideo className="w-3 h-3" />{autoPilotProcessed}/{autoPilotTotal} URLs</span>
                        <span>{Math.round((autoPilotProcessed / autoPilotTotal) * 100)}%</span>
                      </div>
                      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${(autoPilotProcessed / autoPilotTotal) * 100}%` }}
                          transition={{ duration: 0.4 }}
                        />
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>
      )}

      {activeTab !== 'home' && error && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
          <p className="flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-emerald-300">Dismiss</button>
        </motion.div>
      )}

      <div className="mb-6 flex items-center gap-2 text-slate-400">
        {activeTab === 'processing' ? <Loader2 className="w-5 h-5 animate-spin" /> :
         activeTab === 'completed' ? <CheckCircle2 className="w-5 h-5" /> :
         activeTab === 'failed' ? <XCircle className="w-5 h-5" /> :
         <History className="w-5 h-5" />}
        <h3 className="font-bold uppercase tracking-wider text-sm">{activeTab === 'home' ? 'Recent Tasks' : `${tabLabels[activeTab]} Tasks`}</h3>
        <span className="ml-auto text-[10px] text-slate-600 font-mono">{filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="space-y-4">
        {filteredTasks.map((task) => {
          const stats = getEffectiveStats(task);
          const trueStatus = getTrueTaskStatus(task, stats);

          return (
            <div key={task.id} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden transition-all hover:bg-white/[0.07]">
              <div className="p-4 flex items-center gap-4 cursor-pointer" onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}>
                <div className="w-12 h-16 bg-slate-800 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/10">
                  {task.preview?.posterUrl ? (
                    <img src={task.preview.posterUrl} alt={task.preview?.title || 'Movie'} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden'); }} />
                  ) : null}
                  <Film className={`w-5 h-5 text-indigo-400 ${task.preview?.posterUrl ? 'hidden' : ''}`} />
                </div>

                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-sm text-white truncate">{task.preview?.title || 'Processing...'}</h4>
                  <p className="font-mono text-[10px] text-slate-500 truncate mt-0.5">{task.url}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                      trueStatus === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
                      trueStatus === 'failed' ? 'bg-rose-500/20 text-rose-400' :
                      'bg-indigo-500/20 text-indigo-400 animate-pulse'
                    }`}>
                      {trueStatus === 'processing' && activeTaskId === task.id ? '⚡ LIVE' : trueStatus}
                    </span>
                    <span className="text-slate-600 text-[10px]">{formatTime12h(task.createdAt)}</span>
                    {stats.total > 0 && (
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-300 font-mono">{stats.total} links</span>
                        {stats.done > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">✓{stats.done}</span>}
                        {stats.failed > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 font-mono">✗{stats.failed}</span>}
                        {stats.pending > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-mono">⏳{stats.pending}</span>}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {trueStatus === 'failed' && (
                    <button onClick={(e) => handleRetryTask(task, e)} disabled={retryingTaskId === task.id} className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all disabled:opacity-50">
                      {retryingTaskId === task.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    </button>
                  )}
                  <button onClick={(e) => handleDeleteTask(task.id, e)} disabled={deletingTaskId === task.id} className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-all disabled:opacity-50">
                    {deletingTaskId === task.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                  {expandedTask === task.id ? <ChevronDown className="w-5 h-5 text-slate-500" /> : <ChevronRight className="w-5 h-5 text-slate-500" />}
                </div>
              </div>

              <AnimatePresence>
                {expandedTask === task.id && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="border-t border-white/5 bg-black/20">
                    {task.preview?.posterUrl && (
                      <div className="relative h-32 overflow-hidden">
                        <img src={task.preview.posterUrl} alt={task.preview?.title || ''} className="w-full h-full object-cover opacity-30 blur-sm" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 to-transparent" />
                        <div className="absolute bottom-3 left-4 right-4"><h3 className="text-lg font-bold text-white truncate">{task.preview?.title}</h3></div>
                      </div>
                    )}

                    <div className="p-4">
                      {stats.total > 0 && (
                        <div className="grid grid-cols-4 gap-2 mb-4">
                          <div className="bg-slate-800/50 border border-white/5 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-slate-500 font-bold">Total</p>
                            <p className="text-lg font-bold text-white">{stats.total}</p>
                          </div>
                          <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-emerald-500 font-bold">Done</p>
                            <p className="text-lg font-bold text-emerald-400">{stats.done}</p>
                          </div>
                          <div className="bg-rose-500/5 border border-rose-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-rose-500 font-bold">Failed</p>
                            <p className="text-lg font-bold text-rose-400">{stats.failed}</p>
                          </div>
                          <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-amber-500 font-bold">Pending</p>
                            <p className="text-lg font-bold text-amber-400">{stats.pending}</p>
                          </div>
                        </div>
                      )}

                      {task.metadata && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5"><Sparkles className="w-3 h-3" />Highest Quality</label>
                            <p className="text-sm font-bold text-indigo-400">{task.metadata.quality || 'Unknown'}</p>
                          </div>
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5"><Globe className="w-3 h-3" />Languages</label>
                            <p className="text-sm font-bold text-emerald-400">{task.metadata.languages || 'Not Specified'}</p>
                          </div>
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5"><Volume2 className="w-3 h-3" />Audio Label</label>
                            <p className="text-sm font-bold text-amber-400">{task.metadata.audioLabel || 'Unknown'}</p>
                          </div>
                        </div>
                      )}

                      <div className="space-y-3">
                        {task.links.map((link: any, idx: number) => {
                          const effective = getEffectiveLinkData(task, idx, link);
                          return (
                            <LinkCard
                              key={idx}
                              id={idx}
                              name={link.name}
                              logs={effective.logs}
                              finalLink={effective.finalLink}
                              status={effective.status as any}
                            />
                          );
                        })}
                        {task.links.length === 0 && (
                          <div className="flex flex-col items-center py-8 text-slate-400">
                            <Loader2 className="w-8 h-8 animate-spin mb-2" />
                            <p className="text-sm">Scraping in progress...</p>
                            <p className="text-xs opacity-50">You can close this window and return later.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {filteredTasks.length === 0 && (
          <div className="text-center py-12 text-slate-500 border-2 border-dashed border-white/5 rounded-3xl">
            <Rocket className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>{activeTab === 'home' ? 'No tasks yet. Submit a URL to start!' : `No ${tabLabels[activeTab].toLowerCase()} tasks.`}</p>
          </div>
        )}
      </div>

      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-xl border-t border-white/10 safe-area-inset-bottom">
        <div className="max-w-2xl mx-auto flex items-stretch justify-around">
          {([{ key: 'home' as TabType, icon: Home, label: 'Home' }, { key: 'processing' as TabType, icon: Clock, label: 'Processing' }, { key: 'completed' as TabType, icon: CheckCircle2, label: 'Completed' }, { key: 'failed' as TabType, icon: XCircle, label: 'Failed' }, { key: 'history' as TabType, icon: History, label: 'History' }]).map(({ key, icon: Icon, label }) => {
            const isActive = activeTab === key;
            const count = key === 'processing' ? tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'processing').length :
                          key === 'completed' ? tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'completed').length :
                          key === 'failed' ? tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'failed').length :
                          key === 'history' ? tasks.length : 0;

            return (
              <button key={key} onClick={() => setActiveTab(key)} className={`flex-1 flex flex-col items-center gap-0.5 py-3 px-1 transition-all relative ${isActive ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}>
                {isActive && <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-indigo-500 rounded-full" />}
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {count > 0 && key !== 'home' && (
                    <span className={`absolute -top-1.5 -right-2.5 min-w-[16px] h-4 flex items-center justify-center text-[9px] font-bold rounded-full px-1 ${key === 'failed' ? 'bg-rose-500 text-white' : key === 'processing' ? 'bg-indigo-500 text-white' : key === 'completed' ? 'bg-emerald-500 text-white' : 'bg-slate-600 text-white'}`}>
                      {count}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-bold">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
