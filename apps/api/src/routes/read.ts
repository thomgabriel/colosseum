import {
  assets as assetsTable,
  constraintSheets,
  createDb,
  executions,
  goals,
  planLegs,
  plans,
  policies,
  positions,
  rebalances,
  riskSheets,
  schedules,
  stressCases,
} from '@colosseum/db';
import { ApiError, DISCLAIMER } from '@colosseum/schemas';
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** Read routes used by the UI (plan view, monitoring, embed). Everything returned carries provenance where it applies. */
export async function registerReadRoutes(app: FastifyInstance) {
  const { db } = createDb();
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/plans',
    {
      schema: {
        summary: 'Most recent plans',
        querystring: z.object({
          wallet: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(10),
        }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              profile: z.string(),
              capitalUsd: z.string(),
              wallet: z.string().nullable(),
              solverVersion: z.string(),
              createdAt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const rows = req.query.wallet
        ? await db
            .select()
            .from(plans)
            .where(eq(plans.wallet, req.query.wallet))
            .orderBy(desc(plans.createdAt))
            .limit(req.query.limit)
        : await db.select().from(plans).orderBy(desc(plans.createdAt)).limit(req.query.limit);
      return rows.map((p) => ({
        id: p.id,
        profile: p.profile,
        capitalUsd: p.capitalUsd,
        wallet: p.wallet,
        solverVersion: p.solverVersion,
        createdAt: p.createdAt.toISOString(),
      }));
    },
  );

  f.get(
    '/plans/:id',
    {
      schema: {
        summary: 'A plan with its goal, sheet, legs, schedule, stresses, risk sheet and policy',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.any(), 404: ApiError },
      },
    },
    async (req, reply) => {
      const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id));
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const [goal] = await db.select().from(goals).where(eq(goals.id, plan.goalId));
      const [sheet] = await db
        .select()
        .from(constraintSheets)
        .where(eq(constraintSheets.id, plan.constraintSheetId));
      const legs = await db.select().from(planLegs).where(eq(planLegs.planId, plan.id));
      const assetRows = legs.length
        ? await db
            .select()
            .from(assetsTable)
            .where(
              inArray(
                assetsTable.id,
                legs.map((l) => l.assetId),
              ),
            )
        : [];
      const assetById = new Map(assetRows.map((a) => [a.id, a]));
      const sched = await db.select().from(schedules).where(eq(schedules.planId, plan.id));
      const stresses = await db.select().from(stressCases).where(eq(stressCases.planId, plan.id));
      const risk = await db.select().from(riskSheets).where(eq(riskSheets.planId, plan.id));
      const [policy] = await db
        .select()
        .from(policies)
        .where(eq(policies.planId, plan.id))
        .orderBy(desc(policies.createdAt))
        .limit(1);
      const execs = await db
        .select()
        .from(executions)
        .where(eq(executions.planId, plan.id))
        .orderBy(desc(executions.createdAt))
        .limit(50);
      return {
        plan: { ...plan, createdAt: plan.createdAt.toISOString() },
        goal: goal
          ? { id: goal.id, rawText: goal.rawText, language: goal.language, wallet: goal.wallet }
          : null,
        sheet: sheet
          ? {
              sheet: sheet.sheet,
              valid: sheet.valid,
              origin: sheet.origin,
              provenance: sheet.origin === 'fixture' ? 'fixture' : 'live',
            }
          : null,
        legs: legs.map((l) => {
          const a = assetById.get(l.assetId);
          return {
            ...l,
            symbol: a?.symbol ?? l.assetId,
            name: a?.name ?? l.assetId,
            kind: a?.kind,
            mintPath: a?.mintPath,
            label: (a?.metadata as { label?: string } | null)?.label ?? null,
          };
        }),
        schedules: sched,
        stresses,
        riskSheet: risk,
        policy: policy ? { ...policy, createdAt: policy.createdAt.toISOString() } : null,
        executions: execs.map((e) => ({
          ...e,
          createdAt: e.createdAt.toISOString(),
          confirmedAt: e.confirmedAt?.toISOString() ?? null,
        })),
        disclaimer: DISCLAIMER,
      };
    },
  );

  f.get(
    '/wallets/:wallet/positions',
    {
      schema: {
        summary: 'Latest observed positions, executions and rebalances for a wallet',
        params: z.object({ wallet: z.string().min(32) }),
        response: { 200: z.any() },
      },
    },
    async (req) => {
      const rows = await db
        .select()
        .from(positions)
        .where(eq(positions.wallet, req.params.wallet))
        .orderBy(desc(positions.observedAt))
        .limit(200);
      const latest = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!latest.has(r.assetId)) latest.set(r.assetId, r);
      const execs = await db
        .select()
        .from(executions)
        .where(eq(executions.wallet, req.params.wallet))
        .orderBy(desc(executions.createdAt))
        .limit(50);
      const pols = await db
        .select()
        .from(policies)
        .where(eq(policies.wallet, req.params.wallet))
        .orderBy(desc(policies.createdAt))
        .limit(5);
      const rebs = pols.length
        ? await db
            .select()
            .from(rebalances)
            .where(
              inArray(
                rebalances.policyId,
                pols.map((p) => p.id),
              ),
            )
            .orderBy(desc(rebalances.createdAt))
            .limit(20)
        : [];
      return {
        wallet: req.params.wallet,
        positions: [...latest.values()].map((p) => ({
          assetId: p.assetId,
          amount: p.amount,
          valueUsd: p.valueUsd,
          observedAt: p.observedAt.toISOString(),
          source: p.source,
        })),
        executions: execs.map((e) => ({
          id: e.id,
          kind: e.kind,
          assetId: e.assetId,
          status: e.status,
          signature: e.signature,
          explorerUrl: e.explorerUrl,
          error: e.error,
          createdAt: e.createdAt.toISOString(),
        })),
        policies: pols.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
        rebalances: rebs.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        disclaimer: DISCLAIMER,
      };
    },
  );
}
