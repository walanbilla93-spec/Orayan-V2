# Primitive wire codec 1

Implementation slice only; no runtime selector or production caller uses it.

Key bytes: u8 version=1, u8 ASCII family E/D/P/S/N/A/O/X/C/V, u8 kind,
u8 component count, then each component as u32-LE byte length followed by
UTF-16LE code units. Strings preserve lone surrogates and exact legacy identity.
Kind tags: record=1, child=2, ordinal=3, bucket=4, aggregate=5, membership=6,
summary=7. Per-family semantic adapters remain unimplemented. No numeric/string
coercion occurs at this layer. Typed signatures will be value payloads.

Slots are exactly the frozen 80-byte LE layout. Flag 0=value, 1=tombstone,
2=blob reference. The primitive returns blob-reference bytes; production blob
validation is not implemented. Max inline key=64 KiB, value=1 MiB; future
integration must stream oversized legacy values into authenticated blobs.

SHA-256 orders `(digest, full key)` and its first byte routes to one of 256
shards. A test-only injected digest can exercise full-key collision handling;
no production selector can enable the test path.

Merkle domain is the eight ASCII bytes `RSV3PAGE` followed by:

- Leaf: u8 1, u8 role (slots=1, values=2), u64-LE page index,
  u64-LE actual page length, exact page bytes.
- Parent: u8 2, left 32-byte digest, right 32-byte digest.
- Pad: u8 3, u8 role, u64-LE leaf ordinal.
- Empty file: u8 4, u8 role.

Data page size 65,536. Tree header is 64 bytes: ASCII `RSV3MT01` at 0,
u32-LE version=1 at 8, u32-LE role at 12, u64-LE data length at 16,
page count at 24, power-of-two leaf base at 32; bytes 40..63 are zero.
Heap node n (one-based) starts at `64+(n-1)*32`. Empty tree has one pad node
and a separate canonical empty root. Tree size and header are checked before
lookup. Data paths derive from bound whole-file SHA as `<sha>.<role>`;
tree paths derive from bound SHA as `<treeSha>.mtree`. This removes duplicate
path/hash strings to meet the 1-KiB descriptor bound. Roots/family manifests
are not implemented yet; callers must supply a trusted descriptor.

All I/O positions/length sums must be nonnegative safe JS integers. Larger
on-disk u64 values fail closed, never round. Readers verify requested pages
and sibling paths before positive or negative answers. Verified-byte cache
identity includes data SHA, role, page root and ordinal. Memory budgets:
cache <=12 MiB accounted, <=32 read handles, fixed-depth proof workspace.
Overlay <=8 MiB encoded and <=16 MiB conservative allocation accounting;
actual heap/RSS still require qualification. Fold sorts only the bounded
overlay. One current record/value and page/hash buffers are read at a time.

The checked-in codec-v1.json fixture comes from the independent byte generator
in backend/tools/research-v3-fixtures.js. Fixtures are frozen before integration.
Changes to tags, tuple encoding, hash envelopes or slots require version review.
