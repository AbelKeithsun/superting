const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function mockElectron(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getAppPath: () => "/tmp/superting-test",
        getPath: () => "/tmp/superting-test",
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { wavToFloat32Samples } = require("../../src/helpers/ffmpegUtils");

// Build a minimal mono WAV with arbitrary chunks before the data chunk.
function buildWav({ audioFormat = 1, bitsPerSample = 16, samples, extraChunk }) {
  const bytesPerSample = bitsPerSample / 8;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(audioFormat, 0);
  fmt.writeUInt16LE(1, 2); // channels
  fmt.writeUInt32LE(16000, 4);
  fmt.writeUInt32LE(16000 * bytesPerSample, 8);
  fmt.writeUInt16LE(bytesPerSample, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);

  const chunks = [Buffer.from("WAVE"), chunk("fmt ", fmt)];
  if (extraChunk) chunks.push(chunk(extraChunk.id, extraChunk.data));
  chunks.push(chunk("data", samples));

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WAVE", 8, "ascii");
  // fix: "WAVE" already in body; rebuild properly
  return Buffer.concat([header.slice(0, 8), body]);

  function chunk(id, data) {
    const head = Buffer.alloc(8);
    head.write(id, 0, "ascii");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data]);
  }
}

function readAll(float32Buffer) {
  const out = new Array(float32Buffer.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = float32Buffer.readFloatLE(i * 4);
  return out;
}

test("parses 16-bit PCM WAV (the FFmpeg-converted default path)", () => {
  const samples = Buffer.alloc(4 * 2);
  samples.writeInt16LE(-32768, 0);
  samples.writeInt16LE(32767, 2);
  samples.writeInt16LE(0, 4);
  samples.writeInt16LE(16384, 6);
  const wav = buildWav({ bitsPerSample: 16, samples });
  assert.deepEqual(readAll(wavToFloat32Samples(wav)), [-1, 32767 / 32768, 0, 0.5]);
});

test("parses 8-bit unsigned PCM WAV", () => {
  const samples = Buffer.from([0, 128, 255]);
  const wav = buildWav({ bitsPerSample: 8, samples });
  assert.deepEqual(readAll(wavToFloat32Samples(wav)), [-1, 0, 127 / 128]);
});

test("parses 24-bit PCM WAV with sign extension", () => {
  const samples = Buffer.alloc(3 * 2);
  samples.writeIntLE(-8388608, 0, 3); // min
  samples.writeIntLE(8388607, 3, 3); // max
  const wav = buildWav({ bitsPerSample: 24, samples });
  assert.deepEqual(readAll(wavToFloat32Samples(wav)), [-1, 8388607 / 8388608]);
});

test("parses 32-bit integer PCM WAV", () => {
  const samples = Buffer.alloc(4 * 2);
  samples.writeInt32LE(-2147483648, 0);
  samples.writeInt32LE(1073741824, 4);
  const wav = buildWav({ bitsPerSample: 32, samples });
  assert.deepEqual(readAll(wavToFloat32Samples(wav)), [-1, 0.5]);
});

test("parses 32-bit IEEE float WAV (format 3) without bit-casting garbage", () => {
  const samples = Buffer.alloc(4 * 3);
  samples.writeFloatLE(-1.0, 0);
  samples.writeFloatLE(0.25, 4);
  samples.writeFloatLE(0.75, 8);
  const wav = buildWav({ audioFormat: 3, bitsPerSample: 32, samples });
  assert.deepEqual(readAll(wavToFloat32Samples(wav)), [-1.0, 0.25, 0.75]);
});

test("resolves WAVE_FORMAT_EXTENSIBLE (0xFFFE) via the SubFormat GUID", () => {
  const guid = Buffer.alloc(16);
  guid.writeUInt16LE(3, 0); // SubFormat = IEEE float
  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(0xfffe, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(16000, 4);
  fmt.writeUInt32LE(16000 * 4, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(32, 14);
  fmt.writeUInt16LE(22, 16); // cbSize
  guid.copy(fmt, 24);

  const samples = Buffer.alloc(4 * 2);
  samples.writeFloatLE(-0.5, 0);
  samples.writeFloatLE(0.5, 4);
  const chunks = [Buffer.from("WAVE")];
  const head = (id, data) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, "ascii");
    h.writeUInt32LE(data.length, 4);
    return Buffer.concat([h, data]);
  };
  chunks.push(head("fmt ", fmt), head("data", samples));
  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  const wav = Buffer.concat([riff, body]);

  assert.deepEqual(readAll(wavToFloat32Samples(wav)), [-0.5, 0.5]);
});

test("skips JUNK chunks before fmt/data (Apple `say` output layout)", () => {
  const samples = Buffer.alloc(2 * 2);
  samples.writeInt16LE(-16384, 0);
  samples.writeInt16LE(16384, 2);
  const wav = buildWav({
    bitsPerSample: 16,
    samples,
    extraChunk: { id: "JUNK", data: Buffer.alloc(28) },
  });
  assert.deepEqual(readAll(wavToFloat32Samples(wav)), [-0.5, 0.5]);
});

test("clamps a stale/oversized data chunk size to the buffer length", () => {
  const samples = Buffer.alloc(2 * 2);
  samples.writeInt16LE(1, 0);
  samples.writeInt16LE(-1, 2);
  const wav = buildWav({ bitsPerSample: 16, samples });
  // lie about the data size: claim 1MB while only 4 bytes exist
  wav.writeUInt32LE(1024 * 1024, wav.length - 4 - 8 + 4);
  assert.equal(wavToFloat32Samples(wav).length, 8); // 2 samples, not 512K
});

test("rejects unknown audio formats with a clear error", () => {
  const samples = Buffer.from([0, 0, 0, 0]);
  const wav = buildWav({ audioFormat: 6, bitsPerSample: 16, samples }); // a-law
  assert.throws(() => wavToFloat32Samples(wav), /Unsupported WAV audio format: 6/);
});
