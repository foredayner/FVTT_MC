module.exports = {
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  inherits (ctor, superCtor) { Object.setPrototypeOf(ctor.prototype, superCtor.prototype); Object.setPrototypeOf(ctor, superCtor) },
  inspect: (v) => String(v),
  deprecate: (fn) => fn
}
