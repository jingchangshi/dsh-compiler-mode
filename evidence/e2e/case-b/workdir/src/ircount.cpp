#include "ircount.h"
namespace ircount {
void Counter::add(std::size_t n) { total_ += n; }
void Counter::reset() { total_ = 0; }
std::size_t Counter::count() const { return total_; }
void Counter::mergeFrom(Counter &other) {
  total_ += other.total_;
  other.reset();
}
} // namespace ircount
