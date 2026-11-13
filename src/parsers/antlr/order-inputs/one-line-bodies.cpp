// Class bodies written on one line, with and without a wrapping namespace: the same members as the lines below.
struct First { int id; };
struct Base { First actions; void Work() { actions.id = 1; } int total() const { return actions.id; } };
namespace league { struct Club { void Play() { Work(); } int rank; }; }
namespace league { namespace util { struct Kit { Kit() {} ~Kit() {} void Wear() {} }; } }
namespace { struct Hidden { void Tuck() {} }; }

struct Spread {
  First actions;
  void Work() { actions.id = 1; }
};

void run() {
  Base b;
  b.Work();
  league::Club c;
  c.Play();
}
