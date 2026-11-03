/** Exact original owner selection, never a provider-stopped assertion. */
export type ClosedFamilyScope = {
    taskId: string;
    primarySessionId: string;
    delegateSessionId: string;
    repositoryId: string;
    machineId: string;
    worktreePath: string;
    toolingRevision: string;
};
export type ClosedProviderEvidence = {
    sessionId: string;
    recordDigest: string;
    historyDigest: string;
    messages: unknown[];
    lastPromptAt: string | null;
    lastUsedAt: string;
    lastRequestId: string | null;
    absence: "recorded-pid-ESRCH" | "recorded-exit";
};
export type ClosedFamilyReservation<T> = {
    scope: ClosedFamilyScope;
    run: (evidence: ClosedProviderEvidence[], assertUnchanged: () => Promise<void>) => Promise<T>;
};
