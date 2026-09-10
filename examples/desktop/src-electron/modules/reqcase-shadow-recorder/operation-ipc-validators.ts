import { z } from 'zod';

import type {
  TestSessionOperationDetailInput,
  TestSessionOperationListInput,
  TestSessionOperationRebuildInput,
  TestSessionOperationUpdateInput,
} from '../../../types/operation-contracts';
import { KNOWN_OPERATION_OUTCOME_STATUSES } from '../../../types/operation-contracts';

const MAX_SESSION_ID_LENGTH = 256;
const MAX_OPERATION_ID_LENGTH = 256;
const MAX_CURSOR_LENGTH = 256;
const MAX_TRANSITION_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_ALIAS_LENGTH = 240;
const MAX_NOTE_LENGTH = 2000;
const MAX_REASON_LENGTH = 500;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const OperationSessionIdSchema = optionalTrimmedString(MAX_SESSION_ID_LENGTH);
const OperationCursorSchema = optionalTrimmedString(MAX_CURSOR_LENGTH);
const OperationIdSchema = requiredTrimmedString(MAX_OPERATION_ID_LENGTH, 'operationId');
const OperationTransitionIdSchema = optionalTrimmedString(MAX_TRANSITION_ID_LENGTH);

const OperationLimitSchema = z
  .number()
  .finite()
  .optional()
  .default(DEFAULT_LIMIT)
  .transform((value) => Math.max(1, Math.min(MAX_LIMIT, Math.floor(value))));

const OperationTimestampSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .optional();

const OperationOutcomeStatusSchema = z.enum(KNOWN_OPERATION_OUTCOME_STATUSES).optional();

function optionalTrimmedString(maxLength: number) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null) {
        return undefined;
      }
      return typeof value === 'string' ? value.trim() || undefined : value;
    },
    z.string().max(maxLength).optional(),
  );
}

function requiredTrimmedString(maxLength: number, fieldName: string) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.string().min(1, `${fieldName} is required`).max(maxLength),
  );
}

export const OperationListInputSchema = z.preprocess(
  (value) => (value === undefined || value === null ? {} : value),
  z.object({
    sessionId: OperationSessionIdSchema,
    cursor: OperationCursorSchema,
    limit: OperationLimitSchema,
  }),
) satisfies z.ZodType<TestSessionOperationListInput>;

export const OperationDetailInputSchema = z.object({
  sessionId: OperationSessionIdSchema,
  operationId: OperationIdSchema,
}) satisfies z.ZodType<TestSessionOperationDetailInput>;

export const OperationRebuildInputSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) {
      return {};
    }
    if (typeof value === 'string') {
      return { sessionId: value };
    }
    return value;
  },
  z.object({
    sessionId: OperationSessionIdSchema,
  }),
) satisfies z.ZodType<TestSessionOperationRebuildInput>;

export const OperationUpdateInputSchema = z
  .object({
    sessionId: OperationSessionIdSchema,
    operationId: OperationIdSchema,
    title: optionalTrimmedString(MAX_TITLE_LENGTH),
    resultSummary: optionalTrimmedString(MAX_SUMMARY_LENGTH),
    selectedOutcomeStatus: OperationOutcomeStatusSchema,
    selectedTransitionId: OperationTransitionIdSchema,
    ignored: z.boolean().optional(),
    businessAlias: optionalTrimmedString(MAX_ALIAS_LENGTH),
    note: optionalTrimmedString(MAX_NOTE_LENGTH),
    reason: optionalTrimmedString(MAX_REASON_LENGTH),
    occurredAtMs: OperationTimestampSchema,
  })
  .superRefine((value, context) => {
    const hasChange = value.title !== undefined
      || value.resultSummary !== undefined
      || value.selectedOutcomeStatus !== undefined
      || value.selectedTransitionId !== undefined
      || value.ignored !== undefined
      || value.businessAlias !== undefined
      || value.note !== undefined;

    if (!hasChange) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one operation override field is required',
        path: ['operationId'],
      });
    }
  }) satisfies z.ZodType<TestSessionOperationUpdateInput>;

export function parseOperationIpcInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new Error(`${label} validation failed: ${fields.join(', ')}`);
  }
  return result.data;
}
