/* Inputs for the order check: C statements against declarations, casts against calls. */
typedef struct Car { int wheels; } Car;
typedef struct Club Club;
struct Club { int players; };

static int garage_count(Car *garage, int n) { return n * garage->wheels; }

int shapes(Car *a, Club *b) {
  int total = 0;
  Car *c;
  Car (*maker)(int);
  Club x;
  a * b;
  total = (int)garage_count(a, 1);
  total = (Car *)a != 0 ? total : garage_count(a, 2);
  for (int i = 0; i < b->players; i++) { total += garage_count(a, i); }
  if (total < 3 && garage_count(a, 0) > 1) { total = 0; }
  switch (total) { case 1: break; default: total = 2; }
  return total;
}
