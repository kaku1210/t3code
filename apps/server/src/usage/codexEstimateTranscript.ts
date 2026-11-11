import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { SelectedFields, TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";

import {
  CodexScanState,
  codexUsageFormat,
  initialCodexScanState,
} from "../provider/Drivers/codexUsage.ts";
import { EstimateEvent } from "./usageEstimate.ts";
import type { TranscriptParsePosition } from "./usageTranscriptReader.ts";

const decodeEvent = Schema.decodeUnknownOption(EstimateEvent);
const Capture = Schema.Struct({
  databaseId: Schema.String,
  occurrences: Schema.Record(Schema.String, Schema.mutableKey(Schema.Int)),
  events: Schema.mutable(Schema.Array(EstimateEvent)),
  missingQuotaTicks: Schema.mutableKey(Schema.Int),
  invalidRecords: Schema.mutableKey(Schema.Int),
});
// Optional metadata keeps cached usage from deleted, pre-estimate rollouts readable.
const State = Schema.Struct({
  ...CodexScanState.fields,
  estimateCapture: Schema.mutableKey(Schema.optionalKey(Capture)),
});
type State = typeof State.Type;
const decodeState = Schema.decodeUnknownSync(State);
const emptyCapture = (): typeof Capture.Type => ({
  databaseId: "",
  occurrences: {},
  events: [],
  missingQuotaTicks: 0,
  invalidRecords: 0,
});
const initialState = (): State => ({ ...initialCodexScanState(), estimateCapture: emptyCapture() });

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseProjected(parsed: unknown, state: State) {
  const captured = (state.estimateCapture ??= emptyCapture());
  const events = captured.events;
  const raw = object(parsed);
  const payload = object(raw?.payload);
  const malformedBefore = state.malformedRecords;
  const records = codexUsageFormat.parseProjected(parsed, state);
  for (const record of records) {
    if (!record.sessionId || !record.model) {
      captured.invalidRecords++;
      continue;
    }
    const identity = JSON.stringify([
      "usage",
      record.sessionId,
      record.timestampMs,
      record.model,
      record.speed,
      record.totals,
    ]);
    const occurrence = captured.occurrences[identity] ?? 0;
    captured.occurrences[identity] = occurrence + 1;
    events.push({
      id: JSON.stringify([identity, occurrence]),
      kind: "usage",
      timestampMs: record.timestampMs,
      sessionId: record.sessionId,
      model: record.model,
      totals: record.totals,
      speed: record.speed,
      speedKnown: state.sawThreadSettings && record.unresolvedServiceTierTurnId === undefined,
    });
  }
  if (payload?.type !== "token_count" || state.suppressingForkCopies) return records;
  const timestampMs = typeof raw?.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
  if (!Number.isFinite(timestampMs) || state.sessionId.length === 0) {
    captured.invalidRecords++;
    return records;
  }
  if (
    state.malformedRecords > malformedBefore ||
    (records.length > 0 && state.modelProvider !== "openai")
  ) {
    events.push({
      id: JSON.stringify(["issue", state.sessionId, timestampMs]),
      kind: "issue",
      timestampMs,
      sessionId: state.sessionId,
      reason: state.malformedRecords > malformedBefore ? "malformed_usage" : "unsupported_provider",
    });
  }
  const limits = object(payload.rate_limits);
  if (!limits) {
    captured.missingQuotaTicks++;
    return records;
  }
  if (limits.limit_id !== "codex") return records;
  for (const position of ["primary", "secondary"]) {
    const window = object(limits[position]);
    if (!window) continue;
    const quota = decodeEvent({
      id: JSON.stringify([
        "quota",
        state.sessionId,
        timestampMs,
        limits.limit_id,
        window.window_minutes,
        window.resets_at,
        window.used_percent,
      ]),
      kind: "quota",
      sessionId: state.sessionId,
      timestampMs,
      usedPercent: window.used_percent,
      windowMinutes: window.window_minutes,
      resetsAtMs: typeof window.resets_at === "number" ? window.resets_at * 1000 : null,
      limitId: limits.limit_id,
      plan: typeof limits.plan_type === "string" ? limits.plan_type : null,
      origin: "session_cache",
    });
    if (Option.isSome(quota)) events.push(quota.value);
    else {
      captured.invalidRecords++;
      events.push({
        id: JSON.stringify(["issue", state.sessionId, timestampMs, "quota", position]),
        kind: "issue",
        timestampMs,
        sessionId: state.sessionId,
        reason: "malformed_quota",
      });
    }
  }
  return records;
}

/** Captures observations in the existing streaming read, before its uncommitted tail copy. */
export const codexEstimateFormat: TranscriptUsageFormat<State> = {
  ...codexUsageFormat,
  selectFields: {
    ...codexUsageFormat.selectFields,
    payload: { ...(codexUsageFormat.selectFields.payload as SelectedFields), rate_limits: true },
  },
  state: { initial: initialState, schema: State },
  parseProjected,
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      (state.estimateCapture ??= emptyCapture()).invalidRecords++;
      return [];
    }
    return parseProjected(parsed, state);
  },
};

/** A cache from another database must be replayed even when its file has not changed. */
export function hasCodexEstimateCapture(position: TranscriptParsePosition, databaseId: string) {
  return object(object(position.state)?.estimateCapture)?.databaseId === databaseId;
}

/** Only advance the caller's checkpoint after this batch commits to its matching database. */
export function takeCodexEstimateCapture(position: TranscriptParsePosition, databaseId: string) {
  const state = decodeState(position.state);
  const captured = state.estimateCapture!;
  return {
    events: captured.events,
    invalidRecords: captured.invalidRecords,
    position: {
      ...position,
      state: { ...state, estimateCapture: { ...captured, databaseId, events: [] } },
    },
  };
}

/** Bounded offline import shares the runtime reducer but rejects malformed complete records. */
export function parseCodexEstimateTranscript(contents: string) {
  const state = initialState();
  const lines = contents.split("\n");
  const tail = lines.pop() ?? "";
  for (const line of lines) {
    if (!codexUsageFormat.usageMarkers.some((marker) => line.includes(marker))) continue;
    parseProjected(JSON.parse(line), state);
  }
  const captured = state.estimateCapture!;
  if (captured.invalidRecords > 0)
    throw new Error("Codex estimate transcript has invalid complete records.");
  return {
    events: captured.events,
    missingQuotaTicks: captured.missingQuotaTicks,
    pendingTail: tail.length > 0,
  };
}
