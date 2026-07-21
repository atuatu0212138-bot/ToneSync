/**
 * 极简 ZIP 打包（store 模式，不压缩——JPEG/PNG 本身已压缩）。
 * 用于批量下载图片的 Safari/无 FSA 降级路径（PRD §4.2 批量导出）。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** entries: [{name, data: Uint8Array}] → ZIP Blob（文件名 UTF-8）。 */
export function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const num = (n, bytes) => {
    const b = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) b[i] = (n >>> (8 * i)) & 0xFF;
    return b;
  };
  for (const { name, data } of entries) {
    const nameB = enc.encode(name);
    const crc = crc32(data);
    // 本地文件头（bit11 = UTF-8 文件名）
    const local = [
      num(0x04034b50, 4), num(20, 2), num(0x0800, 2), num(0, 2), num(0, 2), num(0, 2),
      num(crc, 4), num(data.length, 4), num(data.length, 4),
      num(nameB.length, 2), num(0, 2), nameB, data,
    ];
    central.push({ nameB, crc, size: data.length, offset });
    for (const p of local) { parts.push(p); offset += p.length; }
  }
  const cdStart = offset;
  for (const c of central) {
    for (const p of [
      num(0x02014b50, 4), num(20, 2), num(20, 2), num(0x0800, 2), num(0, 2), num(0, 2), num(0, 2),
      num(c.crc, 4), num(c.size, 4), num(c.size, 4), num(c.nameB.length, 2),
      num(0, 2), num(0, 2), num(0, 2), num(0, 2), num(0, 4), num(c.offset, 4), c.nameB,
    ]) { parts.push(p); offset += p.length; }
  }
  parts.push(num(0x06054b50, 4), num(0, 2), num(0, 2),
    num(central.length, 2), num(central.length, 2),
    num(offset - cdStart, 4), num(cdStart, 4), num(0, 2));
  return new Blob(parts, { type: 'application/zip' });
}
