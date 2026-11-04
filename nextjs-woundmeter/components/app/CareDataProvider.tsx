"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { CareApiError, getPatientRecord, listPatients, reviewQueue } from "@/lib/care-api";
import type { PatientCompleteRecord, PatientSummary, ReviewQueueItem } from "@/lib/care-types";

type CareData = {
  patients: PatientSummary[] | null;
  records: Record<string, PatientCompleteRecord>;
  recordErrors: Record<string, CareApiError>;
  listError: CareApiError | null;
  queue: ReviewQueueItem[] | null;
  loading: boolean;
  refresh: () => Promise<void>;
  refreshPatient: (patientId: string) => Promise<PatientCompleteRecord | null>;
  refreshQueue: () => Promise<void>;
};

const CareDataContext = createContext<CareData | null>(null);

function asApiError(err: unknown): CareApiError {
  if (err instanceof CareApiError) return err;
  return new CareApiError("NETWORK_ERROR", err instanceof Error ? err.message : "Request failed.", 0);
}

/**
 * Loads the patients the signed-in account is assigned to (care team, shared access or own record)
 * and, for medical staff, the review queue. Other patients are opened from search.
 */
export function CareDataProvider({
  enabled,
  withQueue,
  onAuthExpired,
  children,
}: {
  enabled: boolean;
  withQueue: boolean;
  onAuthExpired: () => void;
  children: React.ReactNode;
}) {
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);
  const [records, setRecords] = useState<Record<string, PatientCompleteRecord>>({});
  const [recordErrors, setRecordErrors] = useState<Record<string, CareApiError>>({});
  const [listError, setListError] = useState<CareApiError | null>(null);
  const [queue, setQueue] = useState<ReviewQueueItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleError = useCallback(
    (err: CareApiError) => {
      if (err.status === 401) onAuthExpired();
    },
    [onAuthExpired],
  );

  const refreshPatient = useCallback(
    async (patientId: string) => {
      try {
        const record = await getPatientRecord(patientId);
        setRecords((prev) => ({ ...prev, [patientId]: record }));
        setRecordErrors(({ [patientId]: _removed, ...rest }) => rest);
        return record;
      } catch (caught) {
        const err = asApiError(caught);
        handleError(err);
        setRecordErrors((prev) => ({ ...prev, [patientId]: err }));
        // A lost connection keeps a record already on screen, so an open form and its unsaved
        // entries survive; the connection banner says nothing can be saved meanwhile.
        setRecords((prev) => {
          if (err.status === 0 && prev[patientId]) return prev;
          const { [patientId]: _removed, ...rest } = prev;
          return rest;
        });
        return null;
      }
    },
    [handleError],
  );

  const refreshQueue = useCallback(async () => {
    if (!withQueue) return;
    try {
      setQueue(await reviewQueue());
    } catch (caught) {
      handleError(asApiError(caught));
      setQueue([]);
    }
  }, [withQueue, handleError]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setListError(null);
    try {
      const list = await listPatients();
      setPatients(list);
      await Promise.all([refreshQueue(), ...list.map((p) => refreshPatient(p.patient_id))]);
    } catch (caught) {
      const err = asApiError(caught);
      handleError(err);
      setListError(err);
      setPatients([]);
    } finally {
      setLoading(false);
    }
  }, [enabled, refreshPatient, refreshQueue, handleError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ patients, records, recordErrors, listError, queue, loading, refresh, refreshPatient, refreshQueue }),
    [patients, records, recordErrors, listError, queue, loading, refresh, refreshPatient, refreshQueue],
  );
  return <CareDataContext.Provider value={value}>{children}</CareDataContext.Provider>;
}

export function useCareData(): CareData {
  const ctx = useContext(CareDataContext);
  if (!ctx) throw new Error("useCareData must be used inside CareDataProvider");
  return ctx;
}

/** Pending and recently closed review requests (server-scoped to the clinician). */
export function useReviewQueue(): { pending: ReviewQueueItem[]; closed: ReviewQueueItem[] } {
  const { queue } = useCareData();
  return useMemo(() => {
    const all = queue ?? [];
    return {
      pending: all.filter((i) => i.status === "AWAITING_CLINICAL_REVIEW"),
      closed: all.filter((i) => i.status !== "AWAITING_CLINICAL_REVIEW"),
    };
  }, [queue]);
}
