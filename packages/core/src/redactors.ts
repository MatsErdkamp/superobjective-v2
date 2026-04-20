import type { RunTrace, TraceRedactor } from "./types";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]+\b/gi;
const API_KEY_RE = /\b(?:sk|pk|api|token)_[A-Za-z0-9_-]{8,}\b/gi;
const CREDIT_CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;

function redactString(value: string) {
  return value
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(BEARER_RE, "Bearer [redacted-token]")
    .replace(API_KEY_RE, "[redacted-api-key]")
    .replace(CREDIT_CARD_RE, "[redacted-card]")
    .replace(PHONE_RE, "[redacted-phone]");
}

function deepRedact<TValue>(value: TValue): TValue {
  if (typeof value === "string") {
    return redactString(value) as TValue;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => deepRedact(entry)) as TValue;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        deepRedact(entry),
      ]),
    ) as TValue;
  }

  return value;
}

export function standardPIIRedactor(): TraceRedactor {
  return {
    redactTrace(trace: RunTrace) {
      return deepRedact(trace);
    },
  };
}

export const standardPII = standardPIIRedactor;

export const redactors = {
  standardPII,
};
