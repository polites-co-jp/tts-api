import { describe, expect, it } from "vitest";
import { fixWavHeader, parseWav, wavSeconds } from "../src/audio.js";
import { makeWav } from "./helpers.js";

describe("wav helpers", () => {
  it("reads format and length", () => {
    const info = parseWav(makeWav(48000));
    expect(info).toMatchObject({ channels: 1, sampleRate: 48000, bitsPerSample: 16, dataLength: 96000 });
    expect(wavSeconds(makeWav(24000))).toBeCloseTo(0.5);
  });

  it("skips odd-sized chunks before data", () => {
    expect(wavSeconds(makeWav(4800, 48000, { list: true }))).toBeCloseTo(0.1);
  });

  it("fixes unknown sizes written by a pipe", () => {
    const fixed = fixWavHeader(makeWav(4800, 48000, { unknownSizes: true }));
    expect(fixed.readUInt32LE(4)).toBe(fixed.length - 8);
    expect(parseWav(fixed)?.dataLength).toBe(9600);
    expect(fixed.readUInt32LE(40)).toBe(9600);
  });

  it("rejects non-wav data", () => {
    expect(parseWav(Buffer.from("not a wav file at all"))).toBeUndefined();
    expect(() => fixWavHeader(Buffer.from("nope"))).toThrow();
  });
});
