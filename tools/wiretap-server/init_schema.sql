-- wiretap-schema-postgres.sql
-- Version: 20260113
-- Schema for raw CAN frames + decoded signals

SET client_min_messages = NOTICE;

-- ----------------------------------------
-- Helper: safe byte accessor for bytea
-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_byte_safe(p bytea, n int)
RETURNS int
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN octet_length(p) > n THEN get_byte(p, n) ELSE NULL END
$$;

-- ----------------------------------------
-- Raw Frames
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS public.can_frame (
  row_id      BIGSERIAL   PRIMARY KEY,
  ts          timestamptz NOT NULL,               -- message/kernel receive time
  ingest_ts   timestamptz NOT NULL DEFAULT now(), -- ingest time 
  id          integer     NOT NULL,               -- arbitration id (decimal)
  id_hex      text GENERATED ALWAYS AS (          -- derived from id + extended
                  lpad(upper(to_hex(id)),
                  CASE WHEN extended THEN 8 ELSE 3 END, '0')
               ) STORED,
  extended    boolean     NOT NULL,               -- 11-bit if false or 29-bit if true
  dlc         smallint    NOT NULL                 -- data length (0..8 for Classic CAN or 0..64 for FD)
                CHECK (dlc >= 0 AND dlc <= 64),
  is_fd       boolean     NOT NULL,               -- CAN FD flag
  data_bytes  bytea       NOT NULL,               -- raw payload
  data_hex    text GENERATED ALWAYS AS (          -- derived from data_bytes
                  upper(encode(data_bytes, 'hex'))
               ) STORED,
  bus         integer     NOT NULL DEFAULT 0,     -- gvret bus id
  dir         text        NOT NULL DEFAULT 'rx'   -- gvret frame direction (rx/tx)
                CHECK (dir IN ('rx', 'tx'))
);

-- Helpful indexes (time- and id-oriented, DESC for "recent first" queries)
CREATE INDEX IF NOT EXISTS idx_can_frame_ts
  ON public.can_frame (ts DESC);
CREATE INDEX IF NOT EXISTS idx_can_frame_id_ts
  ON public.can_frame (id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_can_frame_id_extended_ts
  ON public.can_frame (id, extended, ts DESC);
CREATE INDEX IF NOT EXISTS idx_can_frame_id_ts_row_id_desc
  ON public.can_frame (id, ts DESC, row_id DESC);
CREATE INDEX IF NOT EXISTS idx_can_frame_iface_ts
  ON public.can_frame (bus, ts DESC);
CREATE INDEX IF NOT EXISTS idx_can_frame_dir_ts
  ON public.can_frame (dir, ts DESC);

-- ----------------------------------------
-- Convenience view: expose b0..b7
-- ----------------------------------------
CREATE OR REPLACE VIEW public.can_frame_bytes AS
SELECT
  row_id, ts, ingest_ts, id, id_hex, extended, dlc, is_fd, data_bytes, data_hex, bus, dir,
  public.get_byte_safe(data_bytes, 0)  AS b0,
  public.get_byte_safe(data_bytes, 1)  AS b1,
  public.get_byte_safe(data_bytes, 2)  AS b2,
  public.get_byte_safe(data_bytes, 3)  AS b3,
  public.get_byte_safe(data_bytes, 4)  AS b4,
  public.get_byte_safe(data_bytes, 5)  AS b5,
  public.get_byte_safe(data_bytes, 6)  AS b6,
  public.get_byte_safe(data_bytes, 7)  AS b7
FROM public.can_frame;

-- ----------------------------------------
-- Convenience view: expose b0..b63
-- ----------------------------------------
CREATE OR REPLACE VIEW public.can_fd_frame_bytes AS
SELECT
  row_id, ts, ingest_ts, id, id_hex, extended, dlc, is_fd, data_bytes, data_hex, bus, dir,
  public.get_byte_safe(data_bytes, 0)  AS b0,
  public.get_byte_safe(data_bytes, 1)  AS b1,
  public.get_byte_safe(data_bytes, 2)  AS b2,
  public.get_byte_safe(data_bytes, 3)  AS b3,
  public.get_byte_safe(data_bytes, 4)  AS b4,
  public.get_byte_safe(data_bytes, 5)  AS b5,
  public.get_byte_safe(data_bytes, 6)  AS b6,
  public.get_byte_safe(data_bytes, 7)  AS b7,
  public.get_byte_safe(data_bytes, 8)  AS b8,
  public.get_byte_safe(data_bytes, 9)  AS b9,
  public.get_byte_safe(data_bytes, 10) AS b10,
  public.get_byte_safe(data_bytes, 11) AS b11,
  public.get_byte_safe(data_bytes, 12) AS b12,
  public.get_byte_safe(data_bytes, 13) AS b13,
  public.get_byte_safe(data_bytes, 14) AS b14,
  public.get_byte_safe(data_bytes, 15) AS b15,
  public.get_byte_safe(data_bytes, 16) AS b16,
  public.get_byte_safe(data_bytes, 17) AS b17,
  public.get_byte_safe(data_bytes, 18) AS b18,
  public.get_byte_safe(data_bytes, 19) AS b19,
  public.get_byte_safe(data_bytes, 20) AS b20,
  public.get_byte_safe(data_bytes, 21) AS b21,
  public.get_byte_safe(data_bytes, 22) AS b22,
  public.get_byte_safe(data_bytes, 23) AS b23,
  public.get_byte_safe(data_bytes, 24) AS b24,
  public.get_byte_safe(data_bytes, 25) AS b25,
  public.get_byte_safe(data_bytes, 26) AS b26,
  public.get_byte_safe(data_bytes, 27) AS b27,
  public.get_byte_safe(data_bytes, 28) AS b28,
  public.get_byte_safe(data_bytes, 29) AS b29,
  public.get_byte_safe(data_bytes, 30) AS b30,
  public.get_byte_safe(data_bytes, 31) AS b31,
  public.get_byte_safe(data_bytes, 32) AS b32,
  public.get_byte_safe(data_bytes, 33) AS b33,
  public.get_byte_safe(data_bytes, 34) AS b34,
  public.get_byte_safe(data_bytes, 35) AS b35,
  public.get_byte_safe(data_bytes, 36) AS b36,
  public.get_byte_safe(data_bytes, 37) AS b37,
  public.get_byte_safe(data_bytes, 38) AS b38,
  public.get_byte_safe(data_bytes, 39) AS b39,
  public.get_byte_safe(data_bytes, 40) AS b40,
  public.get_byte_safe(data_bytes, 41) AS b41,
  public.get_byte_safe(data_bytes, 42) AS b42,
  public.get_byte_safe(data_bytes, 43) AS b43,
  public.get_byte_safe(data_bytes, 44) AS b44,
  public.get_byte_safe(data_bytes, 45) AS b45,
  public.get_byte_safe(data_bytes, 46) AS b46,
  public.get_byte_safe(data_bytes, 47) AS b47,
  public.get_byte_safe(data_bytes, 48) AS b48,
  public.get_byte_safe(data_bytes, 49) AS b49,
  public.get_byte_safe(data_bytes, 50) AS b50,
  public.get_byte_safe(data_bytes, 51) AS b51,
  public.get_byte_safe(data_bytes, 52) AS b52,
  public.get_byte_safe(data_bytes, 53) AS b53,
  public.get_byte_safe(data_bytes, 54) AS b54,
  public.get_byte_safe(data_bytes, 55) AS b55,
  public.get_byte_safe(data_bytes, 56) AS b56,
  public.get_byte_safe(data_bytes, 57) AS b57,
  public.get_byte_safe(data_bytes, 58) AS b58,
  public.get_byte_safe(data_bytes, 59) AS b59,
  public.get_byte_safe(data_bytes, 60) AS b60,
  public.get_byte_safe(data_bytes, 61) AS b61,
  public.get_byte_safe(data_bytes, 62) AS b62,
  public.get_byte_safe(data_bytes, 63) AS b63
FROM public.can_frame;

-- ----------------------------------------
-- Import function
-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_can_frame(
  _ts timestamptz,
  _extended boolean,
  _is_fd boolean,
  _id integer DEFAULT NULL,
  _id_hex text DEFAULT NULL,
  _dlc smallint DEFAULT NULL,
  _data_bytes bytea DEFAULT NULL,
  _bus integer DEFAULT 0,
  _dir text DEFAULT 'rx'
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_id integer;
  v_row_id bigint;
BEGIN
  -- Exactly one of id / id_hex must be provided
  IF (_id IS NULL) = (_id_hex IS NULL) THEN
     RAISE EXCEPTION 'Provide exactly one of id or id_hex';
  END IF;

  v_id := COALESCE(_id, public.hex_to_int(_id_hex));

  IF _data_bytes IS NULL THEN
    RAISE EXCEPTION 'Provide data_bytes';
  END IF;

  -- If dlc not provided, derive from payload length
  IF _dlc IS NULL THEN
    _dlc := octet_length(_data_bytes);
  END IF;

  INSERT INTO public.can_frame
    (ts, id, extended, dlc, is_fd, data_bytes, bus, dir)
  VALUES
    (_ts, v_id, _extended, _dlc, _is_fd, _data_bytes, _bus, _dir)
  RETURNING row_id INTO v_row_id;

  RETURN v_row_id;
END $$;

-- ----------------------------------------
-- Helper conversion functions
-- ----------------------------------------
CREATE OR REPLACE FUNCTION public.hex_to_int(p_hex text)
RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (('x' || upper(regexp_replace(p_hex, '^0x', '', 'i')))::bit(32))::int
$$;

-- ----------------------------------------
-- Events table
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS public.events (
    id            BIGSERIAL PRIMARY KEY,
    ts            TIMESTAMPTZ       NOT NULL,
    kind          TEXT              NOT NULL,  -- e.g. 'modbus'
    source        TEXT              NOT NULL,  -- profile-local source name
    key           TEXT              NOT NULL,  -- signal/register identifier
    value_json    JSONB,                        -- raw/normalized value
    meta          JSONB                         -- arbitrary source metadata
);

-- Helpful indexes (time- and id-oriented, DESC for "recent first" queries)
CREATE INDEX IF NOT EXISTS events_ts_idx
  ON public.events (ts DESC);
CREATE INDEX IF NOT EXISTS events_kind_source_idx
  ON public.events (kind, source);
CREATE INDEX IF NOT EXISTS events_key_idx
  ON public.events (key);

-- ----------------------------------------
-- Permissions for ingestion role
-- ----------------------------------------
GRANT USAGE ON SCHEMA public TO candor;
GRANT INSERT, SELECT ON TABLE public.can_frame TO candor;
GRANT USAGE ON SEQUENCE public.can_frame_row_id_seq TO candor;
GRANT EXECUTE ON FUNCTION public.ingest_can_frame(
  timestamptz, boolean, boolean, integer, text, smallint, bytea, integer, text
) TO candor;
GRANT EXECUTE ON FUNCTION public.hex_to_int(text) TO candor;
GRANT EXECUTE ON FUNCTION public.get_byte_safe(bytea, int) TO candor;
GRANT INSERT, SELECT ON TABLE public.events TO candor;
GRANT USAGE ON SEQUENCE public.events_id_seq TO candor;