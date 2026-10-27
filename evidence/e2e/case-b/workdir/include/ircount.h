// IR node counter used by a module-level counting pass.
#pragma once
#include <cstddef>
namespace ircount {
/** Counts the operations observed since the last reset. */
class Counter {
public:
  void add(std::size_t n = 1);
  void reset();
  std::size_t count() const;
  /** Folds `other` into this counter and clears `other`. */
  void mergeFrom(Counter &other);
private:
  std::size_t total_ = 0;
};
} // namespace ircount
