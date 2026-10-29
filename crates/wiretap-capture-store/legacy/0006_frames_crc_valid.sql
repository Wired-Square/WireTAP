-- Whether a Modbus RTU message's CRC matched; NULL where nothing checked one.
ALTER TABLE frames ADD COLUMN crc_valid INTEGER;
