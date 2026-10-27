import type { Json } from './daemon.ts';

export const TASK_COMPLETED = 'task.completed';
export const TASK_FAILED = 'task.failed';
export const TASK_CANCELLED = 'task.cancelled';
export const EVENT_NAMES = [TASK_COMPLETED, TASK_FAILED, TASK_CANCELLED] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export type EventDefinition = {
  name: EventName;
  description: string;
  delivery: readonly ['webhook'];
  inputSchema: Json;
  payloadSchema: Json;
};

const directoryFilter = {
  type: 'object',
  properties: {
    directory: {
      type: 'string',
      description:
        'Absolute workspace directory to watch. Matches tasks dispatched there or below. Omit to watch every allowed workspace.',
    },
  },
  additionalProperties: false,
} as const;

const payloadSchema = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'crashed', 'cancelled', 'unknown'] },
    directory: { type: 'string' },
    previousStatus: { type: ['string', 'null'] },
    occurredAt: { type: 'string' },
  },
  required: ['taskId', 'status', 'directory', 'previousStatus', 'occurredAt'],
  additionalProperties: false,
} as const;

// Only lifecycle transitions TaskFerry actually emits become events. In particular there is no
// input-needed state in the daemon, so advertising task.input_needed would be a promise the
// bridge could never keep.
export const EVENT_CATALOG: readonly EventDefinition[] = [
  {
    name: TASK_COMPLETED,
    description: 'A TaskFerry task finished with status done.',
    delivery: ['webhook'],
    inputSchema: directoryFilter,
    payloadSchema,
  },
  {
    name: TASK_FAILED,
    description: 'A TaskFerry task finished with status crashed or became unknown.',
    delivery: ['webhook'],
    inputSchema: directoryFilter,
    payloadSchema,
  },
  {
    name: TASK_CANCELLED,
    description: 'A TaskFerry task was cancelled.',
    delivery: ['webhook'],
    inputSchema: directoryFilter,
    payloadSchema,
  },
];

export const EVENT_BY_NAME = new Map(EVENT_CATALOG.map((event) => [event.name, event]));

export type TaskStateEvent = {
  type: 'task.state';
  taskId: string;
  directory: string;
  status: string;
  previousStatus: string | null;
  occurredAt: string;
  sequence?: number;
};

export type DeliveryEvent = { name: EventName; data: Json };

const STATUS_EVENTS: Readonly<Record<string, EventName>> = {
  done: TASK_COMPLETED,
  crashed: TASK_FAILED,
  unknown: TASK_FAILED,
  cancelled: TASK_CANCELLED,
};

function asString(value: unknown) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function previousStatusOf(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  return value === null ? null : undefined;
}

// The daemon may add fields later; read only the ones the event contract needs and ignore the
// rest. A malformed frame is dropped rather than delivered with a misleading payload.
export function parseTaskStateEvent(value: unknown): TaskStateEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const event = value as Json;
  if (event.type !== 'task.state') return undefined;
  const taskId = asString(event.taskId);
  const directory = asString(event.directory);
  const status = asString(event.status);
  const occurredAt = asString(event.occurredAt);
  const previousStatus = previousStatusOf(event.previousStatus);
  if (!taskId || !directory) return undefined;
  if (!status || !occurredAt) return undefined;
  if (previousStatus === undefined) return undefined;
  const sequence = typeof event.sequence === 'number' ? event.sequence : undefined;
  return {
    type: 'task.state',
    taskId,
    directory,
    status,
    previousStatus,
    occurredAt,
    sequence,
  };
}

export function deliveryFor(event: TaskStateEvent): DeliveryEvent | undefined {
  const name = STATUS_EVENTS[event.status];
  if (!name) return undefined;
  return {
    name,
    data: {
      taskId: event.taskId,
      status: event.status,
      directory: event.directory,
      previousStatus: event.previousStatus,
      occurredAt: event.occurredAt,
    },
  };
}
