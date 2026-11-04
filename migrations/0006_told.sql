-- What the operator was already told, so a flood of reports wakes nobody twice and a failed alert goes again.
ALTER TABLE docs ADD COLUMN told_csam INTEGER NOT NULL DEFAULT 0;
ALTER TABLE docs ADD COLUMN told_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_stage ADD COLUMN alerted TEXT NOT NULL DEFAULT 'open';
