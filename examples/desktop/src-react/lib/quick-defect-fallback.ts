type ActiveSession = {
  sessionId: string;
};

type SessionNoteInput = {
  title: string;
  message: string;
};

type QuickDefectFallbackApi = {
  getActiveTestSession?: () => Promise<ActiveSession | null>;
  appendTestSessionNote?: (input: SessionNoteInput) => Promise<unknown>;
};

type QuickDefectNote = SessionNoteInput & {
  sessionId: string;
};

function isNoActiveSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /test session is not active|no active session/i.test(message);
}

export async function appendNoteForActiveQuickDefect(
  api: QuickDefectFallbackApi,
  note: QuickDefectNote,
): Promise<boolean> {
  if (!api.getActiveTestSession || !api.appendTestSessionNote) {
    return false;
  }

  let activeSession: ActiveSession | null;
  try {
    activeSession = await api.getActiveTestSession();
  } catch {
    return false;
  }

  if (activeSession?.sessionId !== note.sessionId) {
    return false;
  }

  try {
    await api.appendTestSessionNote({ title: note.title, message: note.message });
    return true;
  } catch (error) {
    if (isNoActiveSessionError(error)) {
      return false;
    }
    throw error;
  }
}
