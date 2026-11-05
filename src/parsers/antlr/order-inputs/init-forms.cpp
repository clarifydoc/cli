// Inputs for the order check (order.test.ts): the decisions the C++ reader settles from tokens, written so the
// same token shapes appear with init statements here and without them in plain-conditions.cpp.
#include <vector>
#include <map>

template <typename T> class Garage {
 public:
  Garage() : cars_{} {}
  int count() const { return cars_.size(); }
  Car front() const;
  void park(Car car);
  std::vector<T> cars_;
  QSet<Club> clubs{};
  Squad squad{make(1)};
};

Car Garage<Car>::front() const { return cars_.front(); }

int pick(Garage<Car>& garage, Club club) {
  if (Car car = garage.front(); car.ready()) garage.park(car);
  if (int n = garage.count(); n > 3) return n;
  if (auto it = clubs.find(club); it != clubs.end()) refit(it);
  switch (int gear = garage.count(); gear) { case 1: shiftUp(gear); break; default: break; }
  if (garage.count()) return 0;
  return 1;
}

void shapes(Player a, Player b, Player c) {
  a * b;
  Player(x);
  Player* p = nullptr;
  std::map<Club, Player> roster;
  bool less = a.rank < b.rank;
  bool both = a.rank < b.rank && c.rank > b.rank;
  Squad<Player> squad = Squad<Player>();
  int shirt = (int)a.shirt;
  int total = (Player)b + count(c);
  QSet<Club> clubs{};
  QSet<Club> bench{make(2)};
}

// A selection statement met while an outer decision looks ahead through it: a brace initializer, a lambda body,
// a statement-expression, an in-class function body.
QSet<Club> fleet{[&] { if (Car car = make(); car.ready()) return 1; return 0; }()};
auto refit = [&](Garage<Car>& g) { if (auto it = g.cars_.begin(); it != g.cars_.end()) { g.park(*it); } };
auto rank = [](Club a, Club b) -> bool { switch (int d = a.points - b.points; d) { case 0: return false; default: return d > 0; } };

class Pit {
  Car spare{[&] { if (Car s = build(); s.ok()) return s; return Car(); }()};
  int laps() const { if (int n = count(); n > 0) return n; return 0; }
  bool ready = [&] { if (check(); fuel > 1) return true; return false; }();
};
