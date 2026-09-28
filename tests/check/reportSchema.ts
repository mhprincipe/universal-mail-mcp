import { z } from 'zod';
import { CHECK_CODES } from '../../src/check/codes.js';

// The check report's schema (design §7.2), strict: an unexpected field fails it.
const code = z.enum(Object.keys(CHECK_CODES) as [string, ...string[]]);
const stageName = z.string().regex(/^(google|server|signin|apps|(account|tools|live|sent):[a-z0-9][a-z0-9-]{0,31})$/);
export const ReportSchema = z.strictObject({
  report: z.literal('universal-mail-check'),
  schema: z.literal(1),
  readme: z.string().min(40),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/),
  at: z.iso.datetime(),
  result: z.enum(['PASS', 'FAIL']),
  stages: z.array(z.discriminatedUnion('status', [
    z.strictObject({ stage: stageName, status: z.literal('PASS') }),
    z.strictObject({ stage: stageName, status: z.literal('FAIL'), code, cause: z.string().min(1), fix: z.string().min(1) }),
    z.strictObject({ stage: stageName, status: z.literal('NOT_RUN'), after: stageName })
  ])),
  facts: z.strictObject({
    accounts: z.number().int().min(0), providers: z.array(z.string()), trial: z.boolean().optional(),
    // The subscription (design §13): its state, never a code or token.
    subscription: z.strictObject({ state: z.enum(['trial', 'active', 'grace', 'read-only']), daysLeft: z.number().int().optional() }).optional()
  })
});
