// 用法：node collab/unpack-session-log.mjs <sessionId> [行数]
import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

const sessionId = process.argv[2] || 'session-0aced974-961b-4245-a99a-3ed38225a7bf'
const tailLines = parseInt(process.argv[3] || '60', 10)
const ZSTD_MAGIC = 0xFD2FB528
const SRC = 'C:/Users/丧彪/.dsh/sessions/--D-Constantly-evolving--/' + sessionId + '/session.jsonl.zstd'
const DST = 'D:/Constantly-evolving/.dsh/collab/session-debug.txt'

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

const buffer = readFileSync(SRC)
const { frames, tornStart } = scanZstdFrames(buffer)
console.log('complete frames:', frames.length, 'torn at:', tornStart === undefined ? 'none' : tornStart)
let text = ''
for (const f of frames) {
  const plain = zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8')
  text += plain
}
writeFileSync(DST, text)
const lines = text.split('\n').filter((l) => l.trim())
console.log('records:', lines.length)
const tail = lines.slice(-tailLines)
for (const l of tail) {
  try {
    const j = JSON.parse(l)
    const type = j.type || j.kind || '?'
    const brief = l.length > 1800 ? l.slice(0, 1800) : l
    console.log('[' + type + '] ' + brief)
  } catch {
    console.log('RAW: ' + l.slice(0, 1800))
  }
}
