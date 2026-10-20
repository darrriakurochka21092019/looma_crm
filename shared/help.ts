import { z } from 'zod';

export const helpGuideIds = [
  'workspace',
  'dashboard',
  'orders',
  'order',
  'clients',
  'finance',
  'tasks',
  'documents',
  'reports',
  'company',
  'team',
  'max',
  'template',
  'import',
  'backup',
  'audit',
  'profile',
  'form-client',
  'form-order',
  'form-payment',
  'form-expense',
  'form-expensePay',
  'form-task',
  'form-document',
  'form-status',
  'form-step',
  'form-contract',
  'form-generate_documents',
  'form-plan',
  'form-tax',
  'form-comments',
] as const;
export type HelpGuideId = (typeof helpGuideIds)[number];
export const helpProgressSchema = z
  .object({
    status: z.enum(['new', 'active', 'completed', 'skipped']),
    last_step: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .nullable(),
    completed: z.array(z.enum(helpGuideIds)).max(helpGuideIds.length),
  })
  .strict();
export type HelpProgress = z.infer<typeof helpProgressSchema>;
export const newHelpProgress = (): HelpProgress => ({
  status: 'new',
  last_step: null,
  completed: [],
});
