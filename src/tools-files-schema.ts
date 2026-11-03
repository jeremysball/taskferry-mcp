import { z } from 'zod';
import { nonBlank } from './tools-shared.ts';

export const MAX_ENTRIES = 500;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const HARD_MAX_BYTES = 1024 * 1024;

export const filesArgs = z.strictObject({
  path: nonBlank
    .max(4096)
    .optional()
    .describe(
      'Absolute path to a directory or regular file. Symlinks are resolved first. Omit when pathBase64 is set.',
    ),
  pathBase64: z
    .string()
    .max(16384)
    .optional()
    .describe(
      'Standard base64 of the absolute path bytes. Use this to reach a path whose name is not valid UTF-8; mutually exclusive with path.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      'File reads only: byte offset. Directories page with after and nextAfter. Default 0.',
    ),
  after: z
    .string()
    .max(4096)
    .optional()
    .describe(
      'Directory listings only: resume after this entry name (exclusive). Use nextAfter or nextAfterBase64 from the previous page.',
    ),
  afterBase64: z
    .string()
    .max(8192)
    .optional()
    .describe(
      'Directory listings only: standard base64 of the raw entry name, exclusive. Use nextAfterBase64; this resumes reliably even when the name is not valid UTF-8.',
    ),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(HARD_MAX_BYTES)
    .optional()
    .describe('File page budget in bytes (default 262144, maximum 1048576).'),
  maxEntries: z
    .number()
    .int()
    .min(1)
    .max(MAX_ENTRIES)
    .optional()
    .describe('Directory page size (default and maximum 500).'),
});

export type FilesArgs = z.infer<typeof filesArgs>;
