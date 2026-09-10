import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  TestSessionPlaybackFocus,
  TestSessionState,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
  TestSessionVideoStream,
} from '../../types/contracts';
import { useDocumentVisibility } from './useDocumentVisibility';

const SESSION_EVENT_LIMIT = 80;
const SESSION_SEGMENT_LIMIT = 72;

type UseRecorderDashboardSnapshotInput = {
  enabled?: boolean;
  isRecording: boolean;
  playbackFocus?: TestSessionPlaybackFocus | null;
  onError: (message: string) => void;
  toUiErrorMessage: (error: unknown) => string;
};

type RecorderDashboardSnapshot = {
  activeSession: TestSessionState | null;
  sessions: TestSessionState[];
  selectedSession: TestSessionState | null;
  selectedSessionId: string | null;
  playbackSession: TestSessionState | null;
  events: TestSessionTimelineEvent[];
  videoStreams: TestSessionVideoStream[];
  recentSegments: TestSessionVideoSegment[];
  matchedSegments: TestSessionVideoSegment[];
  loading: boolean;
  refresh: (preferredSessionId?: string) => Promise<void>;
  selectSession: (sessionId: string) => void;
  clearEvents: (sessionId?: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  deleteSessions: (sessionIds: string[]) => Promise<{ deleted: string[]; skipped: string[] }>;
};

function sortSessionsByRecency(sessions: TestSessionState[]): TestSessionState[] {
  return [...sessions].sort((left, right) => {
    const rightTimestamp = right.updatedAtMs ?? right.startedAtMs;
    const leftTimestamp = left.updatedAtMs ?? left.startedAtMs;
    return rightTimestamp - leftTimestamp;
  });
}

function buildPlaybackCandidates(input: {
  activeSession: TestSessionState | null;
  listedSessions: TestSessionState[];
  selectedSessionId?: string | null;
  focusedSessionId?: string;
}): TestSessionState[] {
  const orderedSessions = sortSessionsByRecency(input.listedSessions);
  const seen = new Set<string>();
  const candidates: TestSessionState[] = [];

  const append = (session: TestSessionState | null | undefined): void => {
    if (!session || seen.has(session.sessionId)) {
      return;
    }
    seen.add(session.sessionId);
    candidates.push(session);
  };

  if (input.focusedSessionId) {
    append(
      input.activeSession?.sessionId === input.focusedSessionId
        ? input.activeSession
        : orderedSessions.find((session) => session.sessionId === input.focusedSessionId),
    );
  }

  if (input.selectedSessionId) {
    append(
      input.activeSession?.sessionId === input.selectedSessionId
        ? input.activeSession
        : orderedSessions.find((session) => session.sessionId === input.selectedSessionId),
    );
  }

  append(input.activeSession);
  orderedSessions.forEach((session) => {
    append(session);
  });

  return candidates;
}

function mergeTailItems<T>(
  current: T[],
  incoming: T[],
  limit: number,
  resolveId: (item: T) => string,
): T[] {
  if (incoming.length === 0) {
    return current;
  }

  const merged = current.slice();
  const seen = new Set(current.map((item) => resolveId(item)));
  for (const item of incoming) {
    const itemId = resolveId(item);
    if (seen.has(itemId)) {
      continue;
    }
    seen.add(itemId);
    merged.push(item);
  }

  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

export function useRecorderDashboardSnapshot(
  input: UseRecorderDashboardSnapshotInput,
): RecorderDashboardSnapshot {
  const [activeSession, setActiveSession] = useState<TestSessionState | null>(null);
  const [sessions, setSessions] = useState<TestSessionState[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<TestSessionTimelineEvent[]>([]);
  const [videoStreams, setVideoStreams] = useState<TestSessionVideoStream[]>([]);
  const [recentSegments, setRecentSegments] = useState<TestSessionVideoSegment[]>([]);
  const [matchedSegments, setMatchedSegments] = useState<TestSessionVideoSegment[]>([]);
  const [playbackSession, setPlaybackSession] = useState<TestSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedSessionIdRef = useRef<string | null>(null);
  const eventsRef = useRef<TestSessionTimelineEvent[]>([]);
  const recentSegmentsRef = useRef<TestSessionVideoSegment[]>([]);
  const eventsCursorRef = useRef<string | null>(null);
  const segmentsCursorRef = useRef<string | null>(null);
  const eventsSessionIdRef = useRef<string | null>(null);
  const segmentsSessionIdRef = useRef<string | null>(null);
  const eventsClearedAfterMsRef = useRef<Map<string, number>>(new Map());
  const hiddenSessionIdsRef = useRef<Set<string>>(new Set());
  const pageVisible = useDocumentVisibility();
  const snapshotSignatureRef = useRef<string>('');
  const playbackSessionIdRef = useRef<string | null>(null);
  const inFlightRefreshRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async (preferredSessionId?: string): Promise<void> => {
    if (inFlightRefreshRef.current) {
      return inFlightRefreshRef.current;
    }

    const run = async (): Promise<void> => {
    const [nextActiveSession, listedSessions] = await Promise.all([
      window.reqcaseShadowRecorder.getActiveTestSession(),
      window.reqcaseShadowRecorder.listTestSessions(),
    ]);
    const nextSessions = listedSessions.filter((session) => !hiddenSessionIdsRef.current.has(session.sessionId));
    const orderedSessions = sortSessionsByRecency(nextSessions);
    const resolvedSelectedSessionId =
      preferredSessionId
      ?? input.playbackFocus?.sessionId
      ?? (
        selectedSessionIdRef.current
          && (
            nextActiveSession?.sessionId === selectedSessionIdRef.current
            || nextSessions.some((session) => session.sessionId === selectedSessionIdRef.current)
          )
          ? selectedSessionIdRef.current
          : null
      )
      ?? nextActiveSession?.sessionId
      ?? orderedSessions[0]?.sessionId
      ?? null;

    const loadEvents = async (sessionId: string | null): Promise<TestSessionTimelineEvent[]> => {
      if (!sessionId) {
        eventsRef.current = [];
        eventsCursorRef.current = null;
        eventsSessionIdRef.current = null;
        return [];
      }

      const shouldReset = eventsSessionIdRef.current !== sessionId;
      if (window.reqcaseShadowRecorder.getTestSessionEventsTail) {
        const tail = await window.reqcaseShadowRecorder.getTestSessionEventsTail({
          sessionId,
          afterEventId: shouldReset ? undefined : eventsCursorRef.current ?? undefined,
          limit: SESSION_EVENT_LIMIT,
        });
        const nextEvents =
          shouldReset || tail.reset
            ? tail.items
            : mergeTailItems(eventsRef.current, tail.items, SESSION_EVENT_LIMIT, (event) => event.eventId);
        const clearedAfterMs = eventsClearedAfterMsRef.current.get(sessionId);
        const visibleEvents = clearedAfterMs
          ? nextEvents.filter((event) => event.occurredAtMs > clearedAfterMs)
          : nextEvents;
        eventsRef.current = visibleEvents;
        eventsCursorRef.current = tail.nextCursor ?? visibleEvents.at(-1)?.eventId ?? null;
        eventsSessionIdRef.current = sessionId;
        return visibleEvents;
      }

      const snapshot = await window.reqcaseShadowRecorder.getTestSessionEvents({
        sessionId,
        limit: SESSION_EVENT_LIMIT,
      });
      const clearedAfterMs = eventsClearedAfterMsRef.current.get(sessionId);
      const visibleSnapshot = clearedAfterMs
        ? snapshot.filter((event) => event.occurredAtMs > clearedAfterMs)
        : snapshot;
      eventsRef.current = visibleSnapshot;
      eventsCursorRef.current = visibleSnapshot.at(-1)?.eventId ?? null;
      eventsSessionIdRef.current = sessionId;
      return visibleSnapshot;
    };

    const playbackCandidates = buildPlaybackCandidates({
      activeSession: nextActiveSession,
      listedSessions: orderedSessions,
      selectedSessionId: resolvedSelectedSessionId,
      focusedSessionId: input.playbackFocus?.sessionId,
    });

    let nextPlaybackSession: TestSessionState | null = null;
    let nextVideoStreams: TestSessionVideoStream[] = [];

    for (const candidate of playbackCandidates.slice(0, 3)) {
      const candidateStreams =
        await (window.reqcaseShadowRecorder.getTestSessionVideoStreams?.({
          sessionId: candidate.sessionId,
        }) ?? Promise.resolve([]));

      if (!nextPlaybackSession) {
        nextPlaybackSession = candidate;
        nextVideoStreams = candidateStreams;
      }

      if (input.playbackFocus?.sessionId && candidate.sessionId === input.playbackFocus.sessionId) {
        nextPlaybackSession = candidate;
        nextVideoStreams = candidateStreams;
        break;
      }

      if (
        candidateStreams.some(
          (stream) =>
            stream.playableSegmentCount > 0
            || stream.segmentCount > 0
            || stream.pendingSegmentCount > 0,
        )
      ) {
        nextPlaybackSession = candidate;
        nextVideoStreams = candidateStreams;
        break;
      }
    }

    const loadSegments = async (sessionId: string | null): Promise<TestSessionVideoSegment[]> => {
      if (!sessionId) {
        recentSegmentsRef.current = [];
        segmentsCursorRef.current = null;
        segmentsSessionIdRef.current = null;
        return [];
      }

      const shouldReset = segmentsSessionIdRef.current !== sessionId;
      if (window.reqcaseShadowRecorder.getTestSessionVideoSegmentsTail) {
        const tail = await window.reqcaseShadowRecorder.getTestSessionVideoSegmentsTail({
          sessionId,
          afterSegmentId: shouldReset ? undefined : segmentsCursorRef.current ?? undefined,
          limit: SESSION_SEGMENT_LIMIT,
        });
        const nextSegments =
          shouldReset || tail.reset
            ? tail.items
            : mergeTailItems(
              recentSegmentsRef.current,
              tail.items,
              SESSION_SEGMENT_LIMIT,
              (segment) => segment.segmentId,
            );
        recentSegmentsRef.current = nextSegments;
        segmentsCursorRef.current = tail.nextCursor ?? nextSegments.at(-1)?.segmentId ?? null;
        segmentsSessionIdRef.current = sessionId;
        return nextSegments;
      }

      const snapshot =
        (await window.reqcaseShadowRecorder.getTestSessionVideoSegments?.({
          sessionId,
          limit: SESSION_SEGMENT_LIMIT,
        })) ?? [];
      recentSegmentsRef.current = snapshot;
      segmentsCursorRef.current = snapshot.at(-1)?.segmentId ?? null;
      segmentsSessionIdRef.current = sessionId;
      return snapshot;
    };

    const [nextEvents, nextRecentSegments, nextMatchedSegments] = await Promise.all([
      loadEvents(resolvedSelectedSessionId),
      loadSegments(nextPlaybackSession?.sessionId ?? null),
      nextPlaybackSession && input.playbackFocus?.occurredAtMs
        ? window.reqcaseShadowRecorder.getTestSessionVideoSegmentsForTimestamp?.({
          sessionId: nextPlaybackSession.sessionId,
          occurredAtMs: input.playbackFocus.occurredAtMs,
          displayId: input.playbackFocus.displayId,
          limit: 32,
        }) ?? Promise.resolve([])
        : Promise.resolve([]),
    ]);

    const signature = [
      nextActiveSession?.sessionId ?? '',
      String(nextActiveSession?.updatedAtMs ?? 0),
      nextActiveSession?.status ?? '',
      orderedSessions.map((session) => session.sessionId + ':' + String(session.updatedAtMs) + ':' + session.status).join('|'),
      resolvedSelectedSessionId ?? '',
      nextPlaybackSession?.sessionId ?? '',
      String(nextEvents.length),
      nextEvents.at(-1)?.eventId ?? '',
      String(nextRecentSegments.length),
      nextRecentSegments.at(-1)?.segmentId ?? '',
      nextVideoStreams.map((stream) => stream.streamId + ':' + String(stream.segmentCount) + ':' + String(stream.playableSegmentCount)).join(','),
      String(nextMatchedSegments.length),
      nextMatchedSegments.at(-1)?.segmentId ?? '',
    ].join('::');

    if (signature === snapshotSignatureRef.current) {
      setLoading(false);
      return;
    }
    snapshotSignatureRef.current = signature;
    playbackSessionIdRef.current = nextPlaybackSession?.sessionId ?? null;

    startTransition(() => {
      selectedSessionIdRef.current = resolvedSelectedSessionId;
      setActiveSession(nextActiveSession);
      setSessions(orderedSessions);
      setSelectedSessionId(resolvedSelectedSessionId);
      setEvents(nextEvents);
      setPlaybackSession(nextPlaybackSession);
      setRecentSegments(nextRecentSegments);
      setVideoStreams(nextVideoStreams);
      setMatchedSegments(nextMatchedSegments);
      setLoading(false);
    });
    };

    const pending = run().finally(() => {
      if (inFlightRefreshRef.current === pending) {
        inFlightRefreshRef.current = null;
      }
    });
    inFlightRefreshRef.current = pending;
    return pending;
  }, [
    input.isRecording,
    input.playbackFocus?.displayId,
    input.playbackFocus?.occurredAtMs,
    input.playbackFocus?.sessionId,
  ]);

  useEffect(() => {
    if (input.enabled === false || !pageVisible) {
      return () => undefined;
    }

    let disposed = false;

    const load = async (): Promise<void> => {
      try {
        await refresh();
      } catch (error) {
        if (!disposed) {
          input.onError(input.toUiErrorMessage(error));
          setLoading(false);
        }
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, input.isRecording ? 2800 : 7000);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [
    input.enabled,
    input.isRecording,
    input.onError,
    input.toUiErrorMessage,
    pageVisible,
    refresh,
  ]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.sessionId === selectedSessionId) ?? activeSession,
    [activeSession, selectedSessionId, sessions],
  );

  const selectSession = useCallback((sessionId: string) => {
    selectedSessionIdRef.current = sessionId;
    setLoading(true);
    setSelectedSessionId(sessionId);
    void refresh(sessionId).catch((error) => {
      input.onError(input.toUiErrorMessage(error));
      setLoading(false);
    });
  }, [input.onError, input.toUiErrorMessage, refresh]);

  const clearEvents = useCallback(async (sessionId?: string): Promise<void> => {
    const targetId = sessionId ?? selectedSessionIdRef.current;
    if (!targetId) {
      eventsRef.current = [];
      setEvents([]);
      return;
    }
    eventsClearedAfterMsRef.current.set(targetId, Date.now());
    eventsRef.current = [];
    setEvents([]);
    const api = window.reqcaseShadowRecorder;
    if (api.purgeTestSessionEvents) {
      try {
        await api.purgeTestSessionEvents({ sessionId: targetId });
      } catch {
        // UI is already cleared; disk purge is best-effort.
      }
    }
  }, []);

  const forgetSessions = useCallback((sessionIds: string[]): void => {
    for (const sessionId of sessionIds) {
      hiddenSessionIdsRef.current.add(sessionId);
      eventsClearedAfterMsRef.current.delete(sessionId);
    }
    if (selectedSessionIdRef.current && sessionIds.includes(selectedSessionIdRef.current)) {
      selectedSessionIdRef.current = null;
      setSelectedSessionId(null);
    }
    setSessions((current) => current.filter((session) => !sessionIds.includes(session.sessionId)));
  }, []);

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    const api = window.reqcaseShadowRecorder;
    if (!api.deleteTestSession) {
      throw new Error('当前版本不支持删除历史会话');
    }
    forgetSessions([sessionId]);
    try {
      await api.deleteTestSession({ sessionId });
    } catch (error) {
      hiddenSessionIdsRef.current.delete(sessionId);
      throw error;
    }
    await refresh();
  }, [forgetSessions, refresh]);

  const deleteSessions = useCallback(async (sessionIds: string[]): Promise<{ deleted: string[]; skipped: string[] }> => {
    const uniqueIds = [...new Set(sessionIds.map((value) => value.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return { deleted: [], skipped: [] };
    }
    const api = window.reqcaseShadowRecorder;
    if (!api.deleteTestSession) {
      throw new Error('当前版本不支持删除历史会话');
    }
    forgetSessions(uniqueIds);
    const result = await api.deleteTestSession({ sessionIds: uniqueIds });
    const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
    for (const sessionId of skipped) {
      hiddenSessionIdsRef.current.delete(sessionId);
    }
    await refresh();
    if (Array.isArray(result?.deleted)) {
      return { deleted: result.deleted, skipped };
    }
    return {
      deleted: result?.deleted === true && result.sessionId ? [result.sessionId] : uniqueIds,
      skipped,
    };
  }, [forgetSessions, refresh]);

  return {
    activeSession,
    sessions,
    selectedSession,
    selectedSessionId,
    playbackSession,
    events,
    videoStreams,
    recentSegments,
    matchedSegments,
    loading,
    refresh,
    selectSession,
    clearEvents,
    deleteSession,
    deleteSessions,
  };
}
