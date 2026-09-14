// Embeddings come back from the ONNX worker either as an ArrayBuffer
// (transferred) or as Uint8Array bytes (body-serialized replies); a Uint8Array
// must be reinterpreted as float32 memory, never as per-element values.
function embeddingToFloat32(embeddingBuffer) {
  if (embeddingBuffer instanceof ArrayBuffer) {
    return new Float32Array(embeddingBuffer);
  }

  const bytes = embeddingBuffer;
  if (!bytes || !bytes.byteLength) {
    return new Float32Array(0);
  }

  if (bytes.byteOffset % 4 === 0 && bytes.byteLength % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  const out = new Float32Array(Math.floor(bytes.byteLength / 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

module.exports = { embeddingToFloat32 };
