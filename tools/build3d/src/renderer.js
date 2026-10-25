/* global Worker, requestAnimationFrame, cancelAnimationFrame, performance */
// Browser 3D view for Blockworld Bridge. Exposed as globalThis.BWB3D.
// Chunk meshing runs in workers (see worker.js); this file owns the three.js scene, the camera,
// simple boxes for other characters and mobs, and block display entities (objects built from
// small transformed blocks), drawn as instanced copies of each block's real model.
const THREE = require('three')

const ENTITY_STYLE = {
  bot: { color: 0x3cdcff, w: 0.6, h: 1.8 },
  player: { color: 0x3cdcff, w: 0.6, h: 1.8 },
  hostile: { color: 0xe62828, w: 0.6, h: 1.8 },
  passive: { color: 0xfadc3c, w: 0.9, h: 0.9 }
}
const EYE = 1.62

/** Same rule as module/scripts/avatar.js: fit the picture in the front face, then scale. */
function illustrationSize (aspect, scale, box) {
  const a = aspect > 0 ? aspect : 1
  const fit = a > box.w / box.h ? { w: box.w, h: box.w / a } : { w: box.h * a, h: box.h }
  return { w: fit.w * scale, h: fit.h * scale }
}

class Renderer3D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{workerUrl:string, atlasUrl:string, blockStatesUrl:string, version:string, workers?:number}} opts
   */
  constructor (canvas, opts) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('lightblue')
    this.scene.fog = new THREE.Fog(0xadd8e6, 40, 72)
    this.scene.add(new THREE.AmbientLight(0xcccccc))
    const sun = new THREE.DirectionalLight(0xffffff, 0.5)
    sun.position.set(1, 1, 0.5).normalize()
    this.scene.add(sun)
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000)
    this.camera.rotation.order = 'ZYX'

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, alphaTest: 0.1 })
    new THREE.TextureLoader().load(opts.atlasUrl, (tex) => {
      tex.magFilter = THREE.NearestFilter
      tex.minFilter = THREE.NearestFilter
      tex.flipY = false
      this.material.map = tex
      this.material.needsUpdate = true
    })

    this.columns = new Map()   // "x,z" -> {minY, height}
    this.meshes = new Map()    // section key -> mesh
    this.entities = new Map()  // id -> mesh
    this.displayParts = []     // [{s: stateId, m: 4x4 column-major}]
    this.models = new Map()    // stateId -> BufferGeometry | 'pending'
    this.displayMeshes = []    // InstancedMesh per block state
    this.target = null         // {x,y,z}
    this.yaw = 0
    this.pitch = 0
    this.ready = false
    this.onReady = null

    this.workers = []
    const n = opts.workers ?? 2
    let readyCount = 0
    for (let i = 0; i < n; i++) {
      const w = new Worker(opts.workerUrl)
      w.onmessage = ({ data }) => {
        if (data.type === 'geometry') this.onGeometry(data)
        else if (data.type === 'model') this.onModel(data)
        else if (data.type === 'ready' && ++readyCount === n) { this.ready = true; this.rebuildDisplays(); this.onReady?.() }
      }
      w.postMessage({ type: 'version', version: opts.version })
      w.postMessage({ type: 'blockStates', url: opts.blockStatesUrl })
      this.workers.push(w)
    }

    this.last = performance.now()
    this.frame = this.frame.bind(this)
    this.raf = requestAnimationFrame(this.frame)
  }

  // ---------- world ----------

  addColumn (x, z, minY, height, json) {
    this.columns.set(`${x},${z}`, { minY, height })
    for (const w of this.workers) w.postMessage({ type: 'chunk', x, z, chunk: json })
    for (let y = minY; y < minY + height; y += 16) {
      this.dirty(x, y, z)
      this.dirty(x - 16, y, z)
      this.dirty(x + 16, y, z)
      this.dirty(x, y, z - 16)
      this.dirty(x, y, z + 16)
    }
  }

  removeColumn (x, z) {
    const col = this.columns.get(`${x},${z}`)
    if (!col) return
    this.columns.delete(`${x},${z}`)
    for (const w of this.workers) w.postMessage({ type: 'unloadChunk', x, z })
    for (let y = col.minY; y < col.minY + col.height; y += 16) {
      this.dirty(x, y, z, false)
      this.dropMesh(`${x},${y},${z}`)
    }
  }

  setBlock (x, y, z, stateId) {
    for (const w of this.workers) w.postMessage({ type: 'blockUpdate', x, y, z, stateId })
    const sx = Math.floor(x / 16) * 16; const sy = Math.floor(y / 16) * 16; const sz = Math.floor(z / 16) * 16
    this.dirty(sx, sy, sz)
    const lx = x - sx; const ly = y - sy; const lz = z - sz
    if (lx === 0) this.dirty(sx - 16, sy, sz)
    if (lx === 15) this.dirty(sx + 16, sy, sz)
    if (ly === 0) this.dirty(sx, sy - 16, sz)
    if (ly === 15) this.dirty(sx, sy + 16, sz)
    if (lz === 0) this.dirty(sx, sy, sz - 16)
    if (lz === 15) this.dirty(sx, sy, sz + 16)
  }

  dirty (x, y, z, value = true) {
    if (!this.columns.has(`${x},${z}`) && value) return
    const h = ((Math.floor(x / 16) + Math.floor(y / 16) + Math.floor(z / 16)) % this.workers.length + this.workers.length) % this.workers.length
    this.workers[h].postMessage({ type: 'dirty', x, y, z, value })
  }

  onGeometry ({ key, geometry: g }) {
    this.dropMesh(key)
    const [x, , z] = key.split(',')
    if (!this.columns.has(`${x},${z}`)) return
    if (!g.positions.length) return // empty section (air)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2))
    geo.setIndex(g.indices)
    const mesh = new THREE.Mesh(geo, this.material)
    mesh.position.set(g.sx, g.sy, g.sz)
    this.meshes.set(key, mesh)
    this.scene.add(mesh)
  }

  dropMesh (key) {
    const m = this.meshes.get(key)
    if (!m) return
    this.scene.remove(m)
    m.geometry.dispose()
    this.meshes.delete(key)
  }

  // ---------- block displays ----------

  /**
   * Block display parts to show (replaces the previous set).
   * @param {{s:number, m:number[]}[]} parts block state id and the world matrix of the unit block
   */
  setDisplays (parts) {
    this.displayParts = parts
    if (this.displayTimer) return
    // several updates in a row (batches of parts) become one rebuild
    this.displayTimer = setTimeout(() => { this.displayTimer = null; this.rebuildDisplays() }, 50)
  }

  rebuildDisplays () {
    if (!this.ready) return
    for (const mesh of this.displayMeshes) { this.scene.remove(mesh); mesh.dispose() }
    this.displayMeshes = []
    const groups = new Map()
    for (const p of this.displayParts) {
      if (!groups.has(p.s)) groups.set(p.s, [])
      groups.get(p.s).push(p.m)
    }
    const matrix = new THREE.Matrix4()
    for (const [stateId, list] of groups) {
      const geo = this.models.get(stateId)
      if (!geo) {
        this.models.set(stateId, 'pending')
        this.workers[0].postMessage({ type: 'blockModel', stateId })
        continue
      }
      if (geo === 'pending' || !geo.attributes.position.count) continue
      const mesh = new THREE.InstancedMesh(geo, this.material, list.length)
      list.forEach((m, i) => mesh.setMatrixAt(i, matrix.fromArray(m)))
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.computeBoundingSphere) mesh.computeBoundingSphere()
      else mesh.frustumCulled = false
      this.displayMeshes.push(mesh)
      this.scene.add(mesh)
    }
  }

  onModel ({ stateId, geometry: g }) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2))
    geo.setIndex(g.indices)
    this.models.set(stateId, geo)
    this.setDisplays(this.displayParts)
  }

  // ---------- camera and entities ----------

  /** Bot feet position (blocks); the camera eases toward it every frame. */
  setTarget (pos) {
    this.target = { x: pos.x, y: pos.y + EYE, z: pos.z }
    if (!this.placed) { this.camera.position.set(this.target.x, this.target.y, this.target.z); this.placed = true }
  }

  /** Mineflayer yaw/pitch (radians). */
  setLook (yaw, pitch) { this.yaw = yaw; this.pitch = pitch }

  /**
   * Other characters and mobs. A character with `avatar` is drawn as a box in its colour with
   * the illustration on the side it faces (`yaw`, Mineflayer radians); others are plain boxes.
   * @param {{id:string|number, kind:string, x:number, y:number, z:number, yaw?:number,
   *          avatar?:{color:string, image:string, scale:number, offsetX?:number, offsetY?:number}}[]} list
   */
  setEntities (list) {
    const seen = new Set()
    for (const e of list) {
      const id = String(e.id)
      seen.add(id)
      const st = ENTITY_STYLE[e.kind] ?? ENTITY_STYLE.passive
      const look = e.avatar ? `${e.avatar.color}|${e.avatar.image}|${e.avatar.scale}|${e.avatar.offsetX ?? 0}|${e.avatar.offsetY ?? 0}` : `kind:${e.kind}`
      let obj = this.entities.get(id)
      if (obj && obj.userData.look !== look) { this.dropEntity(id); obj = null }
      if (!obj) {
        obj = this.makeEntity(st, e.avatar)
        obj.userData.look = look
        obj.position.set(e.x, e.y, e.z)
        if (Number.isFinite(e.yaw)) obj.rotation.y = e.yaw
        this.entities.set(id, obj)
        this.scene.add(obj)
      }
      obj.userData.target = { x: e.x, y: e.y, z: e.z }
      if (Number.isFinite(e.yaw)) obj.userData.yaw = e.yaw
    }
    for (const id of [...this.entities.keys()]) if (!seen.has(id)) this.dropEntity(id)
  }

  /** A group whose origin is at the feet, so turning it spins the box in place. */
  makeEntity (st, avatar) {
    const group = new THREE.Group()
    const color = avatar ? new THREE.Color(avatar.color) : st.color
    const box = new THREE.Mesh(new THREE.BoxGeometry(st.w, st.h, st.w), new THREE.MeshLambertMaterial({ color }))
    box.position.y = st.h / 2
    group.add(box)
    if (avatar?.image) {
      this.loadTexture(avatar.image).then((tex) => {
        if (!tex || !group.parent) return
        const img = tex.image
        const size = illustrationSize(img.width / img.height, avatar.scale, st)
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(size.w, size.h),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.05 }))
        // Mineflayer yaw 0 faces -Z, and a plane faces +Z: turn it around and sit it on the front.
        plane.rotation.y = Math.PI
        // offsetX is "right as seen from the front": the viewer looks along +Z there, so right is -X.
        plane.position.set(-(avatar.offsetX ?? 0), st.h / 2 + (avatar.offsetY ?? 0), -(st.w / 2 + 0.01))
        group.add(plane)
      })
    }
    return group
  }

  /** Each picture is loaded once and shared; a broken link just leaves the plain box. */
  loadTexture (url) {
    this.textures ??= new Map()
    if (!this.textures.has(url)) {
      this.textures.set(url, new Promise((resolve) => {
        const loader = new THREE.TextureLoader()
        loader.setCrossOrigin('anonymous')
        loader.load(url, (tex) => { tex.minFilter = THREE.LinearFilter; resolve(tex) }, undefined, () => resolve(null))
      }))
    }
    return this.textures.get(url)
  }

  dropEntity (id) {
    const obj = this.entities.get(id)
    if (!obj) return
    this.scene.remove(obj)
    obj.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); m.material.dispose() } }) // textures stay cached
    this.entities.delete(id)
  }

  resize (w, h) {
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  frame (now) {
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const k = Math.min(1, dt * 12)
    if (this.target) {
      const p = this.camera.position
      p.x += (this.target.x - p.x) * k
      p.y += (this.target.y - p.y) * k
      p.z += (this.target.z - p.z) * k
    }
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'ZYX')
    for (const obj of this.entities.values()) {
      const t = obj.userData.target
      if (!t) continue
      obj.position.x += (t.x - obj.position.x) * k
      obj.position.y += (t.y - obj.position.y) * k
      obj.position.z += (t.z - obj.position.z) * k
      const yaw = obj.userData.yaw
      if (yaw !== undefined) {
        const d = Math.atan2(Math.sin(yaw - obj.rotation.y), Math.cos(yaw - obj.rotation.y)) // shortest way round
        obj.rotation.y += d * k
      }
    }
    this.renderer.render(this.scene, this.camera)
    this.raf = requestAnimationFrame(this.frame)
  }

  stats () {
    return {
      columns: this.columns.size, meshes: this.meshes.size, entities: this.entities.size, ready: this.ready,
      displays: this.displayParts.length, displayMeshes: this.displayMeshes.length
    }
  }

  dispose () {
    cancelAnimationFrame(this.raf)
    for (const w of this.workers) w.terminate()
    for (const k of [...this.meshes.keys()]) this.dropMesh(k)
    for (const id of [...this.entities.keys()]) this.dropEntity(id)
    clearTimeout(this.displayTimer)
    for (const mesh of this.displayMeshes) { this.scene.remove(mesh); mesh.dispose() }
    for (const geo of this.models.values()) if (geo !== 'pending') geo.dispose()
    for (const p of this.textures?.values() ?? []) p.then((t) => t?.dispose())
    this.renderer.dispose()
  }
}

/** Decode a base64 gzip payload to text (chunk JSON). */
async function gunzipBase64 (b64) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

globalThis.BWB3D = { Renderer3D, gunzipBase64, version: '0.4.0' }
