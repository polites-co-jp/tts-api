/** モノラル 16bit の wav。pipe 出力を真似てサイズ欄を 0xFFFFFFFF にでき、LIST チャンクを挟める */
export function makeWav(samples: number, sampleRate = 48000, opts: { unknownSizes?: boolean; list?: boolean } = {}): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const list = Buffer.alloc(opts.list ? 14 : 0);
  if (opts.list) {
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(5, 4);
    list.write("INFOx", 8, "ascii");
  }
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(opts.unknownSizes ? 0xffffffff : samples * 2, 4);
  const data = Buffer.alloc(samples * 2);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(opts.unknownSizes ? 0xffffffff : 4 + fmt.length + list.length + 8 + data.length, 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, fmt, list, dataHeader, data]);
}
