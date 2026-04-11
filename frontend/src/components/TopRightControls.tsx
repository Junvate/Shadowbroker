'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  MessageSquare,
  CheckCircle2,
  RefreshCw,
  X,
} from 'lucide-react';
import { controlPlaneFetch } from '@/lib/controlPlane';
import {
  requestMeshTerminalOpen,
  subscribeSecureMeshTerminalLauncherOpen,
} from '@/lib/meshTerminalLauncher';
import { purgeBrowserContactGraph, purgeBrowserSigningMaterial, setSecureModeCached, getNodeIdentity, generateNodeKeys } from '@/mesh/meshIdentity';
import { purgeBrowserDmState } from '@/mesh/meshDmWorkerClient';
import {
  fetchInfonetNodeStatusSnapshot,
  type InfonetNodeStatusSnapshot,
} from '@/mesh/controlPlaneStatusClient';
import {
  fetchWormholeStatus,
} from '@/mesh/wormholeIdentityClient';
import { fetchWormholeSettings, joinWormhole } from '@/mesh/wormholeClient';
import { useTheme } from '@/lib/ThemeContext';

interface TopRightControlsProps {
  onTerminalToggle?: () => void;
  onInfonetToggle?: () => void;
  dmCount?: number;
}

export default function TopRightControls({
  onTerminalToggle,
  onInfonetToggle,
  dmCount: _dmCount,
}: TopRightControlsProps = {}) {
  const { uiLanguage, setUiLanguage } = useTheme();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [nodeStep, setNodeStep] = useState<'prompt' | 'terms' | 'activating' | 'disable'>('prompt');
  const [activatingPhase, setActivatingPhase] = useState<'keys' | 'peers' | 'sync' | 'done'>('keys');
  const activatingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activatingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activatingTimedOut, setActivatingTimedOut] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<InfonetNodeStatusSnapshot | null>(null);
  const [nodeStatusError, setNodeStatusError] = useState('');
  const [portalReady, setPortalReady] = useState(false);
  const [nodeToggleBusy, setNodeToggleBusy] = useState(false);
  const [nodeToggleError, setNodeToggleError] = useState('');
  const [terminalLauncherOpen, setTerminalLauncherOpen] = useState(false);
  const [terminalLaunchBusy, setTerminalLaunchBusy] = useState(false);
  const [terminalLaunchError, setTerminalLaunchError] = useState('');
  const [terminalPrivateEnabled, setTerminalPrivateEnabled] = useState(false);
  const [terminalPrivateReady, setTerminalPrivateReady] = useState(false);
  const [terminalTransportTier, setTerminalTransportTier] = useState('public_degraded');
  const launchTerminalDirect = () => {
    if (onTerminalToggle) {
      onTerminalToggle();
      return;
    }
    if (onInfonetToggle) {
      onInfonetToggle();
      return;
    }
    requestMeshTerminalOpen('top-right-controls');
  };

  const openTerminalLauncher = useCallback(async () => {
    setTerminalLaunchError('');
    try {
      const [settings, status] = await Promise.all([
        fetchWormholeSettings(true).catch(() => null),
        fetchWormholeStatus().catch(() => null),
      ]);
      const enabled = Boolean(settings?.enabled ?? status?.running ?? status?.ready ?? false);
      const ready = Boolean(status?.ready);
      setTerminalPrivateEnabled(enabled);
      setTerminalPrivateReady(ready);
      setTerminalTransportTier(
        String(status?.transport_tier || status?.transport_active || 'public_degraded'),
      );
    } catch (error) {
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      setTerminalPrivateEnabled(false);
      setTerminalPrivateReady(false);
      setTerminalTransportTier('public_degraded');
      setTerminalLaunchError(message || 'Private-lane status unavailable.');
    }
    setTerminalLauncherOpen(true);
  }, []);

  useEffect(() => {
    return subscribeSecureMeshTerminalLauncherOpen(() => {
      void openTerminalLauncher();
    });
  }, [openTerminalLauncher]);

  const closeTerminalLauncher = () => {
    if (terminalLaunchBusy) return;
    setTerminalLauncherOpen(false);
    setTerminalLaunchError('');
  };

  const activateWormholeAndLaunchTerminal = async () => {
    setTerminalLaunchBusy(true);
    setTerminalLaunchError('');
    try {
      const settings = await fetchWormholeSettings(true).catch(() => null);
      let runtime = await fetchWormholeStatus().catch(() => null);

      let enabled = Boolean(settings?.enabled ?? runtime?.running ?? runtime?.ready ?? false);
      let ready = Boolean(runtime?.ready);
      let identityNodeId = '';

      const joined = await joinWormhole();
      enabled = Boolean(joined.settings?.enabled ?? joined.runtime?.configured ?? true);
      identityNodeId = String(joined.identity?.node_id || '').trim();
      await applySecureModeBoundary(enabled);

      runtime = joined.runtime ?? runtime;
      ready = Boolean(runtime?.ready);
      const deadline = Date.now() + 12000;
      while (!ready && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        runtime = await fetchWormholeStatus().catch(() => null);
        ready = Boolean(runtime?.ready);
      }
      if (!ready) {
        throw new Error('Wormhole is starting up. Give it a few seconds, then try again.');
      }

      runtime = await fetchWormholeStatus().catch(() => runtime);

      setTerminalPrivateEnabled(enabled);
      setTerminalPrivateReady(Boolean(runtime?.ready ?? true));
      setTerminalTransportTier(
        String(runtime?.transport_tier || runtime?.transport_active || 'private_strong'),
      );
      setTerminalLauncherOpen(false);
      setTerminalLaunchError('');
      setSecureModeCached(true);
      launchTerminalDirect();
      if (identityNodeId) {
        console.info('[top-right] Wormhole terminal launch ready', identityNodeId);
      }
    } catch (error) {
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      setTerminalLaunchError(message || 'Failed to enter Wormhole.');
    } finally {
      setTerminalLaunchBusy(false);
    }
  };

  const applySecureModeBoundary = async (enabled: boolean) => {
    setSecureModeCached(enabled);
    if (!enabled) return;
    purgeBrowserSigningMaterial();
    purgeBrowserContactGraph();
    await purgeBrowserDmState();
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (activatingPollRef.current) clearInterval(activatingPollRef.current);
      if (activatingTimeoutRef.current) clearTimeout(activatingTimeoutRef.current);
    };
  }, []);

  const refreshNodeStatus = async () => {
    const data = await fetchInfonetNodeStatusSnapshot(true);
    setNodeStatus(data);
    setNodeStatusError('');
    return data;
  };

  const stopActivatingPolls = useCallback(() => {
    if (activatingPollRef.current) { clearInterval(activatingPollRef.current); activatingPollRef.current = null; }
    if (activatingTimeoutRef.current) { clearTimeout(activatingTimeoutRef.current); activatingTimeoutRef.current = null; }
  }, []);

  const setNodeEnabled = async (enabled: boolean) => {
    setNodeToggleBusy(true);
    setNodeToggleError('');
    try {
      // Auto-generate keys on first activation
      if (enabled) {
        setActivatingPhase('keys');
        setActivatingTimedOut(false);
        setNodeStep('activating');
        const existing = getNodeIdentity();
        if (!existing) {
          await generateNodeKeys();
        }
        setActivatingPhase('peers');
      }

      const res = await controlPlaneFetch('/api/settings/node', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
        requireAdminSession: false,
      });
      const data = (await res.json().catch(() => ({}))) as {
        detail?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data?.detail || data?.message || 'Node settings update failed');
      }
      await refreshNodeStatus();

      if (enabled) {
        // Start fast-polling for sync progress
        setActivatingPhase('sync');
        stopActivatingPolls();
        activatingPollRef.current = setInterval(async () => {
          try {
            const snap = await fetchInfonetNodeStatusSnapshot(true);
            setNodeStatus(snap);
            const outcome = String(snap?.sync_runtime?.last_outcome || '').toLowerCase();
            if (outcome === 'ok') {
              setActivatingPhase('done');
              stopActivatingPolls();
              // Auto-transition to 'disable' after brief success display
              setTimeout(() => setNodeStep('disable'), 2500);
            }
          } catch { /* ignore poll errors */ }
        }, 3000);
        // Timeout after 90s
        activatingTimeoutRef.current = setTimeout(() => {
          setActivatingTimedOut(true);
        }, 90000);
      } else {
        // Disabling — close modal
        setLauncherOpen(false);
        setNodeStep('prompt');
      }
    } catch (error) {
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: string }).message || '')
          : '';
      setNodeToggleError(message || 'Node settings update failed');
      if (enabled) setNodeStep('terms'); // Go back to terms on error
    } finally {
      setNodeToggleBusy(false);
    }
  };

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    let alive = true;
    const fetchWormhole = async () => {
      try {
        const data = await fetchWormholeSettings();
        const enabled = Boolean(data?.enabled);
        await applySecureModeBoundary(enabled);
      } catch {
        /* ignore */
      }
    };
    const fetchNodeStatus = async () => {
      try {
        const data = await fetchInfonetNodeStatusSnapshot(true);
        if (alive) {
          setNodeStatus(data);
          setNodeStatusError('');
        }
      } catch (error) {
        if (!alive) return;
        const message =
          typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message?: string }).message || '')
            : '';
        setNodeStatusError(message || 'node runtime unavailable');
      }
    };

    const poll = () => {
      fetchWormhole();
      fetchNodeStatus();
    };
    poll();
    const interval = setInterval(poll, 15000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  const nodeMode = String(nodeStatus?.node_mode || 'participant').trim().toUpperCase();
  const nodeEnabled = Boolean(nodeStatus?.node_enabled);
  const syncOutcomeRaw = String(nodeStatus?.sync_runtime?.last_outcome || 'idle')
    .trim()
    .toLowerCase();
  const syncError = String(nodeStatus?.sync_runtime?.last_error || '').trim().toLowerCase();
  const syncOutcome = !nodeEnabled
    ? 'OFF'
    : syncError === 'no active sync peers'
      ? 'SOLO'
      : syncOutcomeRaw === 'ok'
        ? 'CONNECTED'
        : syncOutcomeRaw === 'running'
          ? 'SYNCING'
          : syncOutcomeRaw === 'fork'
            ? 'FORK STOP'
            : syncOutcomeRaw === 'error'
              ? 'SYNC ISSUE'
              : 'ACTIVE';
  const bootstrapFailed = Boolean(nodeStatus?.bootstrap?.last_bootstrap_error);
  const closeLauncher = () => {
    stopActivatingPolls();
    setLauncherOpen(false);
    setNodeStep('prompt');
    setNodeToggleError('');
    setActivatingTimedOut(false);
  };

  // Uniform button style
  const btnBase = 'flex items-center justify-center gap-1 px-2 py-1.5 bg-[var(--bg-primary)]/70 border border-[var(--border-primary)] hover:border-cyan-500/50 hover:bg-[var(--hover-accent)] transition-all text-[10px] text-[var(--text-secondary)] font-mono cursor-pointer min-w-[100px]';

  const nodeLauncherModal =
    portalReady && launcherOpen
      ? createPortal(
          <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
            <button
              type="button"
              aria-label="Close node launcher"
              onClick={closeLauncher}
              className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
            />
            <div className="relative z-[1201] w-full max-w-[520px] border border-cyan-700/40 bg-[var(--bg-primary)]/96 backdrop-blur-sm shadow-[0_0_32px_rgba(0,255,255,0.12)]">
              <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-900/30">
                <div>
                  <div className="text-[10px] font-mono tracking-[0.24em] text-cyan-300">
                    {nodeStep === 'disable'
                      ? 'NODE ACTIVATED'
                      : nodeStep === 'activating'
                        ? 'ACTIVATING NODE'
                        : nodeStep === 'prompt'
                          ? 'ACTIVATE NODE'
                          : 'STIPULATIONS'}
                  </div>
                  <div className="mt-1 text-[9px] font-mono text-[var(--text-muted)]">
                    {nodeMode} • {syncOutcome} • participant-node sync does not require Wormhole
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeLauncher}
                  className="text-[var(--text-muted)] hover:text-cyan-300 transition-colors"
                  title="Close node launcher"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="px-5 py-5 space-y-4">
                {nodeStep === 'disable' ? (
                  <>
                    <div className="border border-cyan-500/20 bg-cyan-950/10 px-4 py-4 text-[10px] font-mono text-cyan-100 leading-[1.8]">
                      Node activated.
                      {(() => { const id = getNodeIdentity(); return id?.nodeId ? (
                        <div className="mt-2 text-[9px] text-cyan-400 font-mono tracking-wide">
                          {id.nodeId}
                        </div>
                      ) : null; })()}
                      <div className="mt-2 text-[9px] text-cyan-200/70 normal-case tracking-normal flex flex-wrap gap-x-3">
                        <span>{syncOutcome.toLowerCase()}</span>
                        {(nodeStatus?.total_events ?? 0) > 0 && <span>{nodeStatus?.total_events} events</span>}
                        {(nodeStatus?.bootstrap?.sync_peer_count ?? 0) > 0 && <span>{nodeStatus?.bootstrap?.sync_peer_count} peers</span>}
                      </div>
                      <div className="mt-3 text-[8px] text-[var(--text-muted)] normal-case tracking-normal leading-[1.8]">
                        Your node keeps syncing as long as the backend is running — you can close this browser tab. To run a headless node without the dashboard, use <span className="text-cyan-400">meshnode.bat</span> (Windows) or <span className="text-cyan-400">meshnode.sh</span> (macOS/Linux).
                      </div>
                    </div>
                    {nodeToggleError && (
                      <div className="border border-amber-500/40 bg-amber-950/20 px-4 py-3 text-[9px] font-mono text-amber-200 leading-[1.7]">
                        {nodeToggleError}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => void setNodeEnabled(false)}
                        disabled={nodeToggleBusy}
                        className="px-4 py-3 border border-rose-500/40 bg-rose-950/20 hover:bg-rose-950/35 disabled:opacity-50 text-[11px] font-mono text-rose-300 tracking-[0.18em]"
                      >
                        {nodeToggleBusy ? 'TURNING OFF...' : 'TURN OFF'}
                      </button>
                      <button
                        type="button"
                        onClick={closeLauncher}
                        disabled={nodeToggleBusy}
                        className="px-4 py-3 border border-[var(--border-primary)] hover:border-cyan-500/40 disabled:opacity-50 text-[11px] font-mono text-[var(--text-muted)] tracking-[0.18em]"
                      >
                        KEEP ON
                      </button>
                    </div>
                  </>
                ) : nodeStep === 'activating' ? (
                  <>
                    <div className="border border-cyan-500/20 bg-black/30 px-4 py-4 space-y-3">
                      {/* Step: Generate identity */}
                      <div className="flex items-center gap-3 text-[10px] font-mono">
                        {activatingPhase === 'keys' ? (
                          <RefreshCw size={11} className="text-cyan-400 animate-spin shrink-0" />
                        ) : (
                          <CheckCircle2 size={11} className="text-green-400 shrink-0" />
                        )}
                        <span className={activatingPhase === 'keys' ? 'text-cyan-300' : 'text-green-300'}>
                          {activatingPhase === 'keys' ? 'Generating identity...' : 'Identity ready'}
                        </span>
                        {activatingPhase !== 'keys' && (() => { const id = getNodeIdentity(); return id?.nodeId ? (
                          <span className="text-[8px] text-cyan-400/70 ml-auto">{id.nodeId}</span>
                        ) : null; })()}
                      </div>
                      {/* Step: Connect to relay */}
                      <div className="flex items-center gap-3 text-[10px] font-mono">
                        {activatingPhase === 'keys' ? (
                          <span className="w-[11px] h-[11px] shrink-0" />
                        ) : activatingPhase === 'peers' ? (
                          <RefreshCw size={11} className="text-cyan-400 animate-spin shrink-0" />
                        ) : (
                          <CheckCircle2 size={11} className="text-green-400 shrink-0" />
                        )}
                        <span className={
                          activatingPhase === 'keys' ? 'text-[var(--text-muted)]'
                          : activatingPhase === 'peers' ? 'text-cyan-300'
                          : 'text-green-300'
                        }>
                          {activatingPhase === 'keys' ? 'Connecting to relay...'
                          : activatingPhase === 'peers' ? 'Connecting to relay...'
                          : 'Relay connected'}
                        </span>
                      </div>
                      {/* Step: Sync chain */}
                      <div className="flex items-center gap-3 text-[10px] font-mono">
                        {(activatingPhase === 'keys' || activatingPhase === 'peers') ? (
                          <span className="w-[11px] h-[11px] shrink-0" />
                        ) : activatingPhase === 'sync' ? (
                          <RefreshCw size={11} className="text-cyan-400 animate-spin shrink-0" />
                        ) : (
                          <CheckCircle2 size={11} className="text-green-400 shrink-0" />
                        )}
                        <span className={
                          (activatingPhase === 'keys' || activatingPhase === 'peers') ? 'text-[var(--text-muted)]'
                          : activatingPhase === 'sync' ? 'text-cyan-300'
                          : 'text-green-300'
                        }>
                          {activatingPhase === 'done'
                            ? `Synced — ${nodeStatus?.total_events ?? 0} events`
                            : activatingPhase === 'sync'
                              ? `Syncing chain...${(nodeStatus?.total_events ?? 0) > 0 ? ` ${nodeStatus?.total_events} events` : ''}`
                              : 'Syncing chain...'}
                        </span>
                      </div>
                      {/* Done banner */}
                      {activatingPhase === 'done' && (
                        <>
                          <div className="mt-2 border border-green-500/30 bg-green-950/20 px-3 py-2 text-[10px] font-mono text-green-300 tracking-[0.15em] text-center">
                            NODE ONLINE
                          </div>
                          <div className="mt-1 text-[8px] font-mono text-[var(--text-muted)] leading-[1.8] normal-case tracking-normal">
                            Your node keeps syncing as long as the backend is running — you can close this browser tab.
                            To run a headless node without the dashboard, use <span className="text-cyan-400">meshnode.bat</span> (Windows) or <span className="text-cyan-400">meshnode.sh</span> (macOS/Linux).
                          </div>
                        </>
                      )}
                    </div>
                    {activatingTimedOut && activatingPhase !== 'done' && (
                      <div className="border border-amber-500/40 bg-amber-950/20 px-4 py-3 text-[9px] font-mono text-amber-200 leading-[1.7]">
                        Sync is taking longer than expected. Your node is active and will continue syncing in the background.
                      </div>
                    )}
                    {nodeToggleError && (
                      <div className="border border-amber-500/40 bg-amber-950/20 px-4 py-3 text-[9px] font-mono text-amber-200 leading-[1.7]">
                        {nodeToggleError}
                      </div>
                    )}
                    {(activatingTimedOut || activatingPhase === 'done') && (
                      <button
                        type="button"
                        onClick={closeLauncher}
                        className="w-full px-4 py-3 border border-cyan-500/40 bg-cyan-950/20 hover:bg-cyan-950/35 text-[11px] font-mono text-cyan-300 tracking-[0.18em]"
                      >
                        CLOSE
                      </button>
                    )}
                  </>
                ) : nodeStep === 'prompt' ? (
                  <>
                    <div className="border border-cyan-500/20 bg-cyan-950/10 px-4 py-4 text-[10px] font-mono text-cyan-100 leading-[1.8]">
                      Do you want to activate a node on this install?
                      <div className="mt-2 text-[9px] text-cyan-200/70 normal-case tracking-normal">
                        This turns on your local participant node and lets this install keep syncing the public Infonet chain.
                      </div>
                    </div>
                    {(bootstrapFailed || nodeStatusError || nodeToggleError) && (
                      <div className="border border-amber-500/40 bg-amber-950/20 px-4 py-3 text-[9px] font-mono text-amber-200 leading-[1.7]">
                        {nodeToggleError || nodeStatusError || nodeStatus?.bootstrap?.last_bootstrap_error || 'Node runtime warning detected.'}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setNodeStep('terms')}
                        className="px-4 py-3 border border-cyan-500/40 bg-cyan-950/20 hover:bg-cyan-950/35 text-[11px] font-mono text-cyan-300 tracking-[0.18em]"
                      >
                        YES
                      </button>
                      <button
                        type="button"
                        onClick={closeLauncher}
                        className="px-4 py-3 border border-[var(--border-primary)] hover:border-cyan-500/40 text-[11px] font-mono text-[var(--text-muted)] tracking-[0.18em]"
                      >
                        NO
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="border border-cyan-500/20 bg-black/30 px-4 py-4 text-[9px] font-mono text-slate-200 leading-[1.85]">
                      <div className="text-cyan-300 tracking-[0.18em]">BY CONTINUING YOU AGREE:</div>
                      <ul className="mt-3 space-y-2 list-disc pl-5">
                        <li>This install can keep a local copy of the public Infonet chain.</li>
                        <li>Participant-node sync is public-facing unless you separately use obfuscated-lane features.</li>
                        <li>Your backend may sync with configured or bundled bootstrap peers in the background.</li>
                        <li>Wormhole is only required for obfuscated gates, experimental inbox, and stronger obfuscated posture.</li>
                      </ul>
                    </div>
                    <div className="text-[8px] font-mono uppercase tracking-[0.2em] text-cyan-300/80">
                      {nodeMode} • {syncOutcome}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => void setNodeEnabled(true)}
                        disabled={nodeToggleBusy}
                        className="px-4 py-3 border border-cyan-500/40 bg-cyan-950/20 hover:bg-cyan-950/35 disabled:opacity-50 text-[11px] font-mono text-cyan-300 tracking-[0.18em]"
                      >
                        {nodeToggleBusy ? 'ACTIVATING...' : 'AGREE'}
                      </button>
                      <button
                        type="button"
                        onClick={closeLauncher}
                        disabled={nodeToggleBusy}
                        className="px-4 py-3 border border-[var(--border-primary)] hover:border-cyan-500/40 disabled:opacity-50 text-[11px] font-mono text-[var(--text-muted)] tracking-[0.18em]"
                      >
                        DISAGREE
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const terminalStatusLabel = terminalPrivateReady
    ? 'PRIVATE LANE READY'
    : terminalPrivateEnabled
      ? 'PRIVATE LANE STARTING'
      : 'PRIVATE LANE OFFLINE';
  const terminalStatusTone = terminalPrivateReady
    ? 'text-emerald-300'
    : terminalPrivateEnabled
      ? 'text-amber-300'
      : 'text-cyan-300';
  const terminalLauncherModal =
    portalReady && terminalLauncherOpen
      ? createPortal(
          <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
            <button
              type="button"
              aria-label="Close terminal launcher"
              onClick={closeTerminalLauncher}
              className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
            />
            <div className="relative z-[1201] w-full max-w-[640px] border border-cyan-700/40 bg-[var(--bg-primary)]/96 backdrop-blur-sm shadow-[0_0_32px_rgba(0,255,255,0.12)]">
              <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-900/30">
                <div>
                  <div className="text-[13px] font-mono tracking-[0.24em] text-cyan-300">
                    INFONET TERMINAL
                  </div>
                  <div className={`mt-1 text-[11px] font-mono ${terminalStatusTone}`}>
                    {terminalStatusLabel} • {terminalTransportTier}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeTerminalLauncher}
                  className="text-[var(--text-muted)] hover:text-cyan-300 transition-colors"
                  title="Close terminal launcher"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="px-5 py-5 space-y-4">
                <div className="border border-cyan-500/20 bg-cyan-950/10 px-4 py-4 text-[13px] font-mono text-cyan-100 leading-[1.8]">
                  {terminalPrivateReady
                    ? 'Enter the Wormhole-facing terminal and sync with the obfuscated Infonet commons?'
                    : 'The terminal runs through Wormhole for obfuscated gates, inbox, and experimental comms.'}
                  <div className="mt-2 text-[12px] text-cyan-200/70 normal-case tracking-normal">
                    {terminalPrivateReady
                      ? 'Your obfuscated identity is already provisioned. Entering now keeps the obfuscated lane separate from the public node sync path.'
                      : 'This turns Wormhole on and opens the obfuscated lane. If you already have a Wormhole identity, it reuses it. If you do not, it bootstraps one once and then keeps using it.'}
                  </div>
                </div>
                {terminalLaunchError && (
                  <div className="border border-amber-500/40 bg-amber-950/20 px-4 py-3 text-[12px] font-mono text-amber-200 leading-[1.7]">
                    {terminalLaunchError}
                  </div>
                )}
                <div className="border border-cyan-500/20 bg-black/30 px-4 py-4 text-[12px] font-mono text-slate-200 leading-[1.85]">
                  <div className="text-cyan-300 tracking-[0.18em]">BEFORE YOU ENTER:</div>
                  <ul className="mt-3 space-y-2 list-disc pl-5">
                    <li>The terminal is for Wormhole, gates, and experimental mail.</li>
                    <li>Your participant node can stay active separately without changing this obfuscated identity lane.</li>
                    <li>Mesh remains the public perimeter. Wormhole is the obfuscated commons.</li>
                  </ul>
                </div>
                <div className="border border-amber-500/20 bg-amber-950/10 px-4 py-3 text-[12px] font-mono text-amber-200/80 leading-[1.85]">
                  <div className="text-amber-300 tracking-[0.18em]">WORMHOLE CLEANUP:</div>
                  <div className="mt-2">
                    Closing the Infonet terminal will shut down Wormhole automatically. If you force-close
                    the browser or the shutdown fails, Wormhole may keep running in the background.
                    Run <span className="text-amber-100 font-bold">killwormhole.bat</span> (Windows) or{' '}
                    <span className="text-amber-100 font-bold">killwormhole.sh</span> (macOS/Linux)
                    from the project root to ensure it is fully stopped.
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => void activateWormholeAndLaunchTerminal()}
                    disabled={terminalLaunchBusy}
                    className="px-4 py-3 border border-cyan-500/40 bg-cyan-950/20 hover:bg-cyan-950/35 disabled:opacity-50 text-[13px] font-mono text-cyan-300 tracking-[0.16em]"
                  >
                    {terminalLaunchBusy
                      ? 'ENTERING...'
                      : terminalPrivateReady
                        ? 'ENTER WORMHOLE'
                        : 'ACTIVATE WORMHOLE'}
                  </button>
                  <button
                    type="button"
                    onClick={closeTerminalLauncher}
                    disabled={terminalLaunchBusy}
                    className="px-4 py-3 border border-[var(--border-primary)] hover:border-cyan-500/40 disabled:opacity-50 text-[13px] font-mono text-[var(--text-muted)] tracking-[0.16em]"
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
    {terminalLauncherModal}
    {nodeLauncherModal}
    <div className="relative flex items-center gap-1.5 mb-1 justify-end">
      {/* Discussions link */}
      <a
        href="https://github.com/BigBodyCobain/Shadowbroker/discussions"
        target="_blank"
        rel="noreferrer"
        className={btnBase}
      >
        <MessageSquare size={11} className="text-cyan-400" />
        <span className="tracking-wider">DISCUSS</span>
      </a>

      <div
        className={`${btnBase} min-w-[100px] gap-0 px-1`}
        data-no-auto-zh
        translate="no"
        lang="en"
      >
        <button
          type="button"
          onClick={() => setUiLanguage('zh')}
          className={`flex-1 px-2 py-1 text-[10px] font-mono tracking-[0.18em] transition-colors ${
            uiLanguage === 'zh'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-[var(--text-muted)] border border-transparent hover:text-cyan-300'
          }`}
        >
          ZH
        </button>
        <button
          type="button"
          onClick={() => setUiLanguage('en')}
          className={`flex-1 px-2 py-1 text-[10px] font-mono tracking-[0.18em] transition-colors ${
            uiLanguage === 'en'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-[var(--text-muted)] border border-transparent hover:text-cyan-300'
          }`}
        >
          EN
        </button>
      </div>
    </div>
    </>
  );
}
