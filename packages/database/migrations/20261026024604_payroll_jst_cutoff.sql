-- Payroll is derived from tasks; preserve old months as zero rows.
UPDATE "payroll" SET "completed_task_count" = 0, "total_reward" = 0;
--> statement-breakpoint
INSERT INTO "payroll" ("child_id", "month", "completed_task_count", "total_reward")
SELECT t."child_id",
  (date_trunc('month', t."completed_at" AT TIME ZONE 'Asia/Tokyo') +
    CASE WHEN p."cutoff_day" AND extract(day FROM t."completed_at" AT TIME ZONE 'Asia/Tokyo') > 15
      THEN interval '1 month' ELSE interval '0 months' END)::date,
  count(*)::integer, sum(t."reward")::integer
FROM "tasks" t
JOIN "parents" p ON p."id" = t."parent_id"
WHERE t."status" = 'DONE' AND t."child_id" IS NOT NULL AND t."completed_at" IS NOT NULL
GROUP BY 1, 2
ON CONFLICT ("child_id", "month") DO UPDATE
SET "completed_task_count" = excluded."completed_task_count", "total_reward" = excluded."total_reward";
