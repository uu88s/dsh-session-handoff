/**
 * 多帧 Zstandard 读取（DSH 会话日志专用）。
 *
 * DSH 会话日志是「一个持久化批次一帧」的串联 zstd，因此帧边界必须从帧头结构算出来，
 * 不能用 magic 字节扫描（压缩负载里可能出现同样的 4 字节）。这里沿用 DSH 自己的
 * 帧布局契约：
 *   - 每帧以 4 字节小端 magic 0xfd2fb528 开头；
 *   - 帧头描述符的保留位必须为 0；
 *   - 每块带 3 字节小端块头，保留块类型 0x3 视为损坏；
 *   - 可选的 4 字节帧校验和跟在最后一个块之后。
 * 只读路径忽略被截断的最后一帧（写进程可能正在追加）。
 */
import { zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const zstdDecompressAsync = promisify(zstdDecompress);
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 扫描串联 zstd 的帧边界。
 * @param {Buffer} buffer 完整文件内容。
 * @param {number} maxFrames 最多返回多少帧。
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`损坏的 Zstandard 会话日志：第 ${offset} 字节处的帧 magic 非法`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`损坏的 Zstandard 会话日志：第 ${offset - 1} 字节处的帧头保留位非零`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 2 ** contentSizeFlag;
    const restHeader = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < restHeader) return { frames, tornStart: start };
    offset += restHeader;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`损坏的 Zstandard 会话日志：第 ${offset - 3} 字节处的块类型保留`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length >= maxFrames) return { frames };
  }
  return { frames };
}

/**
 * 解压全部完整帧。
 * @param {Buffer} buffer
 * @returns {Promise<{content: Buffer, frameCount: number, torn: boolean}>}
 */
export async function decompressAllZstdFrames(buffer) {
  const scan = scanZstdFrames(buffer);
  if (scan.frames.length === 0) throw new Error('会话日志是空的，或首帧不完整');
  const decoded = [];
  for (const frame of scan.frames) {
    decoded.push(await zstdDecompressAsync(buffer.subarray(frame.start, frame.end)));
  }
  return {
    content: Buffer.concat(decoded),
    frameCount: decoded.length,
    torn: scan.tornStart !== undefined,
  };
}
