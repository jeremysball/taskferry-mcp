import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { EventService } from './mcp-events.ts';
import type { ToolScope } from './tools-shared.ts';

const argumentSchema = z.record(z.string(), z.unknown());
const deliverySchema = z.strictObject({
  mode: z.literal('webhook'),
  url: z.string(),
  secret: z.string().optional(),
});
const listSchema = z.strictObject({ cursor: z.string().nullable().optional() });
const subscribeSchema = z.strictObject({
  name: z.string(),
  arguments: argumentSchema.optional(),
  delivery: deliverySchema,
  cursor: z.string().nullable().optional(),
  ttlMs: z.number().int().nonnegative().nullable().optional(),
});
const unsubscribeSchema = z.strictObject({
  name: z.string(),
  arguments: argumentSchema.optional(),
  delivery: deliverySchema,
});

// Custom MCP methods (outside the SDK's spec vocabulary) are registered with an explicit params
// schema. The same authenticated endpoint and token guard cover these as the tool methods.
export function registerEventMethods(
  server: McpServer,
  service: EventService,
  principal: string,
  scope: ToolScope,
) {
  service.registerPrincipal(principal, scope);
  server.server.setRequestHandler('events/list', { params: listSchema }, (params) =>
    service.list(params),
  );
  server.server.setRequestHandler('events/subscribe', { params: subscribeSchema }, (params) =>
    service.subscribe(params, principal),
  );
  server.server.setRequestHandler('events/unsubscribe', { params: unsubscribeSchema }, (params) =>
    service.unsubscribe(params, principal),
  );
}
