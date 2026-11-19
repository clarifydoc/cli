// Inputs for the order check (order.test.ts): the predicates of the C++ grammar that still look at the token before
// the decision (`IsDeclSpecifierType`, `IsPureSpecifierAllowed`) on every shape that reaches them: a parameter after
// `(` or `,`, a name after a type keyword, a pure or defaulted specifier, a declarator in parentheses. A shape that
// parsed one way after another file's decision was cached would read differently in reverse order.
struct Club { virtual void kick() const = 0; virtual int rank() = 0; virtual ~Club() = default; void run() = delete; int x = 0; };

struct Car { virtual void start(); virtual void stop() = 0 ; int fuel = 0; virtual int gear() const noexcept = 0; };

void open(QString);
void close(Club club, Player);
void sign(Player, Club);

void fit(Squad (&squads)[3]);
void check(Result (*f)(Arg));
int run(Callback (*on_goal)(int), int (Club::*member));

void tag(shared_ptr<Case> TEST_CTX);
int goals; Club squad GUARDED_BY(mu);
void f(int goals, Club squad GUARDED_BY(mu));

int total(int goals, Player (*best)(int), Club c);
auto a = (Player)b;
void g(Club = Club(), Player = {});

void h(Car car = make(1), Garage<Car> g = Garage<Car>());
void i(Club(club), Player(*p));

class Pit { void spare(Car c) const = 0; int laps = 0; Car (*maker)(int) = nullptr; };

template <typename T> void park(T car, Garage<T> g = {});
void j(const Club club, Player& p, Car&& q);

void k() { Club c(Player(x)); Club d(Player p); int n(count(c)); QSet<Club> s(make(2)); }
