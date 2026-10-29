-- A received CAN frame's remote request, bit rate switch and error state indicator.
ALTER TABLE frames ADD COLUMN is_rtr INTEGER NOT NULL DEFAULT 0;
ALTER TABLE frames ADD COLUMN is_brs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE frames ADD COLUMN is_esi INTEGER NOT NULL DEFAULT 0;
