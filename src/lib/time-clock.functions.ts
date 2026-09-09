// Registro e verificacao das marcacoes de ponto encadeadas (O1-03a). A marcacao e
// append-only (o banco recusa update/delete): correcao se faz por nova marcacao.
// NSR sequencial e encadeamento gerados sob trava da linha-contador do ente.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
import { hashPunch, GENESIS_HASH } from "./time-clock.server";

const RecordInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  punch_time: z.string().datetime().optional(),
  source: z.enum(["manual", "app", "rep"]).default("manual"),
});

export const recordTimeClockPunch = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RecordInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    const punchTime = (
      data.punch_time ? new Date(data.punch_time) : new Date()
    ).toISOString();
    return withTransaction(async (client) => {
      const link = await client.query(
        "select id from public.employment_links where id=$1 and tenant_id=$2",
        [data.employment_link_id, data.tenant_id],
      );
      if (!link.rows.length)
        throw new Error("Vínculo inválido para esta entidade");
      // Cria (se preciso) e TRAVA a linha-contador do ente: serializa NSR/cadeia.
      await client.query(
        "insert into public.time_clock_counters (tenant_id) values ($1) on conflict (tenant_id) do nothing",
        [data.tenant_id],
      );
      const counter = (
        await client.query(
          "select last_nsr, last_hash from public.time_clock_counters where tenant_id=$1 for update",
          [data.tenant_id],
        )
      ).rows[0];
      const nsr = Number(counter.last_nsr) + 1;
      const previousHash = counter.last_hash;
      const recordHash = hashPunch({
        tenantId: data.tenant_id,
        employmentLinkId: data.employment_link_id,
        nsr,
        punchTime,
        source: data.source,
        previousHash,
      });
      const id = randomUUID();
      await client.query(
        `insert into public.time_clock_punches
           (id, tenant_id, employment_link_id, nsr, punch_time, source,
            previous_hash, record_hash, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.employment_link_id,
          nsr,
          punchTime,
          data.source,
          previousHash,
          recordHash,
          context.userId,
        ],
      );
      await client.query(
        "update public.time_clock_counters set last_nsr=$2, last_hash=$3, updated_at=now() where tenant_id=$1",
        [data.tenant_id, nsr, recordHash],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "register",
        resource: "time_clock_punches",
        recordId: id,
        before: null,
        after: {
          employment_link_id: data.employment_link_id,
          nsr,
          punch_time: punchTime,
          record_hash: recordHash,
        },
      });
      return { id, nsr, recordHash };
    });
  });

const ListInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const getTimeClockPunches = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ListInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const values: unknown[] = [data.tenant_id];
    let filter = "";
    if (data.employment_link_id) {
      values.push(data.employment_link_id);
      filter += ` and employment_link_id=$${values.length}`;
    }
    if (data.from) {
      values.push(data.from);
      filter += ` and punch_time>=$${values.length}`;
    }
    if (data.to) {
      values.push(data.to);
      filter += ` and punch_time<=$${values.length}`;
    }
    return query<{
      id: string;
      employment_link_id: string;
      nsr: number;
      punch_time: string;
      source: string;
      record_hash: string;
    }>(
      `select id, employment_link_id, nsr, punch_time, source, record_hash
       from public.time_clock_punches
       where tenant_id=$1${filter}
       order by nsr`,
      values,
    );
  });

const VerifyInput = z.object({ tenant_id: z.string().uuid() });

export const verifyTimeClockChain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => VerifyInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const rows = await query<{
      employment_link_id: string;
      nsr: number;
      punch_time: string;
      source: string;
      previous_hash: string;
      record_hash: string;
    }>(
      `select employment_link_id, nsr, punch_time, source, previous_hash, record_hash
       from public.time_clock_punches where tenant_id=$1 order by nsr`,
      [data.tenant_id],
    );
    let expectedPrev = GENESIS_HASH;
    for (const row of rows) {
      const punchTime = new Date(row.punch_time).toISOString();
      const recomputed = hashPunch({
        tenantId: data.tenant_id,
        employmentLinkId: row.employment_link_id,
        nsr: Number(row.nsr),
        punchTime,
        source: row.source,
        previousHash: row.previous_hash,
      });
      if (row.previous_hash !== expectedPrev)
        return {
          valid: false,
          brokenAtNsr: Number(row.nsr),
          reason: "encadeamento",
        };
      if (recomputed !== row.record_hash)
        return { valid: false, brokenAtNsr: Number(row.nsr), reason: "hash" };
      expectedPrev = row.record_hash;
    }
    return { valid: true, count: rows.length };
  });
