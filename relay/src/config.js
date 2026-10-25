'use strict'
// Loads config.json (or the path in BWB_CONFIG) and fills defaults from config.example.json.
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

function deepMerge (base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (typeof v === 'object' && v !== null && !Array.isArray(v)) ? deepMerge(base[k] ?? {}, v) : v
  }
  return out
}

function loadConfig (file = process.env.BWB_CONFIG || path.join(ROOT, 'config.json')) {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))
  if (!fs.existsSync(file)) {
    throw new Error(`설정 파일이 없습니다: ${file}\nconfig.example.json 을 config.json 으로 복사하고 token 을 바꾸세요.`)
  }
  const cfg = deepMerge(defaults, JSON.parse(fs.readFileSync(file, 'utf8')))
  if (!cfg.token || cfg.token.startsWith('CHANGE_ME') || cfg.token.length < 16) {
    throw new Error('config.json 의 token 을 16자 이상의 임의 문자열로 바꾸세요.')
  }
  return cfg
}

module.exports = { loadConfig, deepMerge }
