#include "ircount.h"
#include <cstdio>
static int failures = 0;
static void expect(std::size_t got, std::size_t want, const char *what) {
  if (got != want) { std::printf("FAIL %s: got %zu want %zu\n", what, got, want); ++failures; }
  else { std::printf("ok   %s\n", what); }
}
int main() {
  ircount::Counter c;
  c.add(3); c.add(4); expect(c.count(), 7, "add accumulates");
  c.reset(); expect(c.count(), 0, "reset clears");
  ircount::Counter a, b;
  a.add(5); b.add(2);
  a.mergeFrom(b);
  expect(a.count(), 7, "merge adds");
  expect(b.count(), 0, "merge clears source");
  return failures == 0 ? 0 : 1;
}
