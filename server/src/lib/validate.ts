import { z } from 'zod';
import { badRequest } from './errors.js';

/** Validates untrusted input and rewrites zod errors into a 400 with details. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'Validation failed',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format');

export const money = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(60).optional(),
  direction: z.enum(['asc', 'desc']).default('desc'),
  from: dateString.optional(),
  to: dateString.optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function paging(page: number, pageSize: number): { limit: number; offset: number } {
  return { limit: Math.min(pageSize, 500), offset: (page - 1) * Math.min(pageSize, 500) };
}

export function paginated<T>(data: T[], total: number, page: number, pageSize: number, extra: Record<string, unknown> = {}) {
  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: page * pageSize < total,
    },
    ...extra,
  };
}
