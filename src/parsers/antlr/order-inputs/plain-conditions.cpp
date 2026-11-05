// Same token shapes as init-forms.cpp, no init statement anywhere, and statements read the other way round.
#include <vector>
#include <map>

template <typename T> class Garage {
 public:
  Garage(int n) : cars_(n) {}
  int count() const { return cars_.size(); }
  Car front() const { return cars_.front(); }
  void park(Car car);
  std::vector<T> cars_;
  QSet<Club> clubs() const;
};

int pick(Garage<Car>& garage, Club club) {
  if (Car car = garage.front()) garage.park(car);
  if (int n = garage.count()) return n;
  if (auto it = clubs.find(club)) refit(it);
  switch (int gear = garage.count()) { case 1: shiftUp(gear); break; default: break; }
  if (garage.count() > 3) return 0;
  while (Car next = garage.front()) { garage.park(next); }
  return 1;
}

void shapes(Player a, Player b, Player c) {
  a * b;
  Player x2 = Player(x);
  Player (*maker)(int) = nullptr;
  bool less = a < b;
  bool lessEqual = a.rank < b.rank;
  int shirt = static_cast<int>(a.shirt);
  int total = b + count(c);
  QSet<Club> clubs();
  QSet<Club> bench(make(2));
  for (int i = 0; i < count(c); i++) { park(a); }
}

QSet<Club> fleet{[&] { if (Car car = make()) return 1; return 0; }()};
auto refit = [&](Garage<Car>& g) { if (auto it = g.cars_.begin()) { g.park(*it); } };
auto rank = [](Club a, Club b) -> bool { switch (int d = a.points - b.points) { case 0: return false; default: return d > 0; } };

class Pit {
  Car spare{[&] { if (Car s = build()) return s; return Car(); }()};
  int laps() const { if (int n = count()) return n; return 0; }
  bool ready = [&] { if (check()) return true; return false; }();
};
