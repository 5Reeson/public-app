import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import process from 'node:process'
import { setInterval } from 'node:timers'

const mode = process.argv[2] ?? 'success'
const keyChunks = []
for await (const chunk of process.stdin) keyChunks.push(Buffer.from(chunk))
const input = Buffer.concat(keyChunks)
for (const chunk of keyChunks) chunk.fill(0)
if (input.length !== 48) process.exit(2)
const salt = Buffer.from(input.subarray(0, 16))
const key = Buffer.from(input.subarray(16, 48))
input.fill(0)

const grandchildSource =
  mode === 'ignore-term' || mode === 'descendant-ignore-term'
    ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
    : 'setInterval(()=>{},1000)'
const grandchild = spawn(process.execPath, ['-e', grandchildSource], {
  detached: false,
  stdio: 'ignore',
})

process.stdout.write(
  `${JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid })}\n`,
)

const descriptor = Number(process.env.CN_MEMES_CANDIDATE_KEY_FD)
if (!Number.isInteger(descriptor) || descriptor < 3) process.exit(3)
if (mode !== 'silent') {
  const frame = Buffer.alloc(56)
  if (mode === 'invalid') {
    frame.fill(0x7f)
  } else {
    frame.write('CMK1', 0, 'ascii')
    frame[4] = 1
    frame[5] = 1
    salt.copy(frame, 8)
    key.copy(frame, 24)
  }
  writeSync(descriptor, frame)
  frame.fill(0)
}
key.fill(0)
salt.fill(0)

if (mode === 'ignore-term') process.on('SIGTERM', () => undefined)
setInterval(() => undefined, 1_000)
