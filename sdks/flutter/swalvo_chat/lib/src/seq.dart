/// `seq` and `eventSeq` travel as decimal strings because they are 64-bit
/// counters (Phase 3 §1). Dart's `int` is 64-bit on the VM but only 53
/// bits on the web, so everything that compares them goes through
/// [BigInt] here and nobody is tempted to `int.parse` one.
library;

/// Parses a seq off the wire. Accepts a number from a server that sends
/// one; rejects anything that is not a non-negative integer.
BigInt? parseSeq(Object? value) {
  if (value is BigInt) return value.isNegative ? null : value;
  if (value is int) return value < 0 ? null : BigInt.from(value);
  if (value is String && RegExp(r'^\d{1,20}$').hasMatch(value)) {
    return BigInt.parse(value);
  }
  return null;
}

/// Orders two seqs: negative when [a] comes first, positive when [b] does,
/// 0 when equal. A missing or unparseable value sorts first, so a message
/// from a pre-Phase-3 server never jumps ahead of a sequenced one.
///
/// String comparison is the mistake this exists to prevent: `"10" < "9"`.
int compareSeq(String? a, String? b) {
  final left = parseSeq(a);
  final right = parseSeq(b);
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  return left.compareTo(right);
}
