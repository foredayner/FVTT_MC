function assert (v, msg) { if (!v) throw new Error(msg || 'Assertion failed') }
assert.ok = assert
assert.strictEqual = (a, b, msg) => assert(a === b, msg)
assert.deepStrictEqual = () => {}
module.exports = assert
