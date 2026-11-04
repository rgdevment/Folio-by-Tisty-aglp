-- Set by hand when an order asks for more than the usual days, and shown to nobody (decision 42).
ALTER TABLE docs ADD COLUMN legal_until INTEGER;
