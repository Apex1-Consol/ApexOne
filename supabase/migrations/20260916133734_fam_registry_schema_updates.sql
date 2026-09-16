-- Applied directly to apex-one (nducwhlmudksgxggjrbo) on 2026-09-16. Committed here after
-- the fact so the live schema and this repo's tracked migrations stay in sync (same drift
-- this repo already had once before with 20260916081451_fam_registry_schema.sql).

-- qualifications: add SETA column for coverage badges + easier filtering
ALTER TABLE public.qualifications ADD COLUMN IF NOT EXISTS seta text;

-- fam_seta_registrations: multi-role support + explicit active/inactive status
ALTER TABLE public.fam_seta_registrations ADD COLUMN IF NOT EXISTS roles text[];
ALTER TABLE public.fam_seta_registrations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Active';

-- backfill roles[] from legacy single role column for existing rows
UPDATE public.fam_seta_registrations SET roles = ARRAY[role] WHERE roles IS NULL;
