import { describe, expect, it } from 'vitest'

import {
  runWechat4Helper,
  runWechat4HelperForPersonalEmoticons,
  runWechat4HelperWithCandidateFrame,
} from '../../src/main/sources/wechat4/helper-runner.js'

describe('WeChat 4 helper runner', () => {
  it('uses stdin/stdout JSONL and ignores bounded stderr diagnostics', async () => {
    const response = await runWechat4Helper(
      { v: 1, id: 'runner-test', method: 'probe' },
      {
        executable: process.execPath,
        arguments: [
          '-e',
          "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('private native detail');process.stdout.write(JSON.stringify({v:1,id:'runner-test',ok:true,result:{architecture:'fixture'}})+'\\n')})",
        ],
      },
    )

    expect(response).toEqual({
      v: 1,
      id: 'runner-test',
      ok: true,
      result: { architecture: 'fixture' },
    })
  })

  it('rejects extra stdout framing', async () => {
    await expect(
      runWechat4Helper(
        { v: 1, id: 'runner-test', method: 'probe' },
        {
          executable: process.execPath,
          arguments: [
            '-e',
            "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{}\\n{}\\n'))",
          ],
        },
      ),
    ).rejects.toThrow(/framing/i)
  })

  it('sends a candidate frame only over fd 3 and clears it after success', async () => {
    const frame = Buffer.alloc(56, 0x42)
    const response = await runWechat4HelperWithCandidateFrame(
      {
        v: 1,
        id: 'candidate-runner-test',
        method: 'validateCandidateFd',
        params: { databasePath: '/synthetic/fixture.db' },
      },
      frame,
      {
        executable: process.execPath,
        arguments: [
          '-e',
          "const fs=require('node:fs');const frame=Buffer.alloc(56);let offset=0;while(offset<56){offset+=fs.readSync(3,frame,offset,56-offset,null)}let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const result={v:1,id:'candidate-runner-test',ok:true,result:{received:offset,jsonHasCandidate:input.includes('4242424242424242')}};frame.fill(0);process.stdout.write(JSON.stringify(result)+'\\n')})",
        ],
      },
    )

    expect(response).toMatchObject({
      ok: true,
      result: { received: 56, jsonHasCandidate: false },
    })
    expect(frame.equals(Buffer.alloc(56))).toBe(true)
  })

  it('clears the candidate frame after helper failure and timeout cleanup', async () => {
    const failedFrame = Buffer.alloc(56, 0x24)
    await expect(
      runWechat4HelperWithCandidateFrame(
        { v: 1, id: 'candidate-failure', method: 'validateCandidateFd' },
        failedFrame,
        {
          executable: process.execPath,
          arguments: [
            '-e',
            "const fs=require('node:fs');const b=Buffer.alloc(56);fs.readSync(3,b);b.fill(0);process.exit(7)",
          ],
        },
      ),
    ).rejects.toThrow(/code 7/i)
    expect(failedFrame.equals(Buffer.alloc(56))).toBe(true)

    const timedOutFrame = Buffer.alloc(56, 0x18)
    await expect(
      runWechat4HelperWithCandidateFrame(
        { v: 1, id: 'candidate-timeout', method: 'validateCandidateFd' },
        timedOutFrame,
        {
          executable: process.execPath,
          arguments: [
            '-e',
            "const fs=require('node:fs');const b=Buffer.alloc(56);fs.readSync(3,b);b.fill(0);process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
          ],
          timeoutMs: 20,
          terminationGraceMs: 20,
        },
      ),
    ).rejects.toThrow(/timed out/i)
    expect(timedOutFrame.equals(Buffer.alloc(56))).toBe(true)
  })

  it('keeps selected rows off stdout and parses them only from anonymous fd 4', async () => {
    const frame = Buffer.alloc(56, 0x35)
    const result = await runWechat4HelperForPersonalEmoticons(
      {
        v: 1,
        id: 'personal-catalog-runner',
        method: 'personalEmoticonsFd',
        params: { databasePath: '/synthetic/fixture.db' },
      },
      frame,
      {
        executable: process.execPath,
        arguments: [
          '-e',
          "const fs=require('node:fs');const b=Buffer.alloc(56);fs.readSync(3,b);let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const row={order:0,group:'favorite',type:1,md5:'00000000000000000000000000000001',caption:'synthetic caption',thumbUrl:'',tpUrl:'',cdnUrl:'https://synthetic.invalid/asset',externUrl:'',encryptUrl:'',aesKey:'',authKey:''};fs.writeSync(4,JSON.stringify(row)+'\\n');fs.closeSync(4);b.fill(0);process.stdout.write(JSON.stringify({v:1,id:'personal-catalog-runner',ok:true,result:{verified:true,recordCount:1,jsonHasRow:input.includes('synthetic caption')}})+'\\n')})",
        ],
      },
    )

    expect(frame.equals(Buffer.alloc(56))).toBe(true)
    expect(result.response).toMatchObject({
      ok: true,
      result: { verified: true, recordCount: 1, jsonHasRow: false },
    })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      order: 0,
      group: 'favorite',
      md5: '00000000000000000000000000000001',
    })
  })
})
