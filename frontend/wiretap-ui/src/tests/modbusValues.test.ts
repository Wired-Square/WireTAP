import { describe, expect, it } from 'vitest';
import { interpretPair, interpretRegister } from '../utils/modbusValues';

describe('interpretRegister', () => {
  it('reads 0xFFFF as 65535 unsigned and -1 signed', () => {
    const v = interpretRegister([0xff, 0xff]);
    expect(v.hex).toBe('FFFF');
    expect(v.u16).toBe(65535);
    expect(v.s16).toBe(-1);
  });

  it('shows printable bytes as characters', () => {
    expect(interpretRegister([0x4d, 0x42]).ascii).toBe('MB');
  });

  it('replaces non-printable bytes with a dot', () => {
    expect(interpretRegister([0x00, 0x41]).ascii).toBe('.A');
  });

  it('treats the sign boundary as unsigned below 0x8000', () => {
    expect(interpretRegister([0x7f, 0xff]).s16).toBe(32767);
    expect(interpretRegister([0x80, 0x00]).s16).toBe(-32768);
  });

  it('reads a plausible telemetry register', () => {
    // 0x0938 = 2360 — 236.0 V at a 0.1 scale, the Megatec input-voltage shape.
    expect(interpretRegister([0x09, 0x38]).u16).toBe(2360);
  });

  it('treats a missing second byte as zero rather than NaN', () => {
    expect(interpretRegister([0x01]).u16).toBe(256);
  });
});

describe('interpretPair', () => {
  it('reads 1.0 as a big-word-first float', () => {
    expect(interpretPair([0x3f, 0x80], [0x00, 0x00], 'big').f32).toBe(1.0);
  });

  it('reads the same float when the words are swapped and the order says so', () => {
    expect(interpretPair([0x00, 0x00], [0x3f, 0x80], 'little').f32).toBe(1.0);
  });

  it('gives a different answer for the wrong word order', () => {
    expect(interpretPair([0x3f, 0x80], [0x00, 0x00], 'little').f32).not.toBe(1.0);
  });

  it('reads a full-scale u32 without sign overflow', () => {
    const v = interpretPair([0xff, 0xff], [0xff, 0xff], 'big');
    expect(v.u32).toBe(4294967295);
    expect(v.s32).toBe(-1);
  });

  it('combines the high and low words in order', () => {
    expect(interpretPair([0x00, 0x01], [0x00, 0x00], 'big').u32).toBe(65536);
  });

  it('defaults to big word order', () => {
    expect(interpretPair([0x00, 0x01], [0x00, 0x00]).u32).toBe(65536);
  });
});
