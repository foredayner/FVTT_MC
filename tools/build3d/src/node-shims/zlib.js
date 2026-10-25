// prismarine-nbt imports zlib for compressed NBT; the 3D path never decompresses NBT.
const nope = () => { throw new Error('zlib is not available in the browser build') }
module.exports = { gunzip: nope, gunzipSync: nope, inflate: nope, inflateSync: nope, deflateSync: nope, gzipSync: nope, unzip: nope }
