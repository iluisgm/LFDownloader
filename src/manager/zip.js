// Minimal streaming ZIP writer ("stored", no compression — pictures and
// videos are already compressed). Writes through any sink with
// `write(Uint8Array)`, so big archives go to OPFS instead of RAM.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
  }

  /** Make names unique inside the archive ("a.jpg", "a (2).jpg"…). */
  uniqueName(name) {
    let out = name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; this.names.has(out.toLowerCase()); n++) out = `${base} (${n})${ext}`;
    this.names.add(out.toLowerCase());
    return out;
  }

  async add(name, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const nameBytes = new TextEncoder().encode(this.uniqueName(name));
    const crc = crc32(bytes);
    const { time, date } = dosDateTime();
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // local file header
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0x0800, true); // UTF-8 names
    header.setUint16(8, 0, true); // stored
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, bytes.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);
    await this.sink.write(new Uint8Array(header.buffer));
    await this.sink.write(nameBytes);
    await this.sink.write(bytes);
    this.entries.push({ nameBytes, crc, size: bytes.length, offset: this.offset, time, date });
    this.offset += 30 + nameBytes.length + bytes.length;
    if (this.offset > 0xfffffff0) throw new Error('ZIP is too large (over 4 GB)');
  }

  async finish() {
    const start = this.offset;
    let size = 0;
    for (const e of this.entries) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true); // central directory header
      h.setUint16(4, 20, true);
      h.setUint16(6, 20, true);
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, 0, true);
      h.setUint16(12, e.time, true);
      h.setUint16(14, e.date, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.size, true);
      h.setUint32(24, e.size, true);
      h.setUint16(28, e.nameBytes.length, true);
      h.setUint32(42, e.offset, true);
      await this.sink.write(new Uint8Array(h.buffer));
      await this.sink.write(e.nameBytes);
      size += 46 + e.nameBytes.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); // end of central directory
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, start, true);
    await this.sink.write(new Uint8Array(end.buffer));
  }
}
