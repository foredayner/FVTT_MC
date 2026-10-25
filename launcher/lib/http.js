'use strict'
// Downloads with progress and checksum check. The file only appears at `dest` once it is complete and verified.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { USER_AGENT } = require('./state')

async function getJson (url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} 응답 ${res.status}`)
  return res.json()
}

/**
 * @param {{sha1?: string, sha256?: string, onProgress?: (done:number,total:number)=>void, fetchImpl?: Function}} opts
 */
async function download (url, dest, { sha1, sha256, onProgress, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status}): ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const part = dest + '.part'
  const out = fs.createWriteStream(part)
  const hash = crypto.createHash(sha256 ? 'sha256' : 'sha1')
  let done = 0
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      done += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      onProgress?.(done, total)
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    fs.rmSync(part, { force: true })
    throw err
  }
  const want = (sha256 || sha1 || '').toLowerCase()
  const got = hash.digest('hex')
  if (want && want !== got) {
    fs.rmSync(part, { force: true })
    throw new Error('받은 파일의 체크섬이 맞지 않습니다. 다시 시도하세요.')
  }
  fs.renameSync(part, dest)
  return { size: done, hash: got }
}

module.exports = { getJson, download }
