import { describe, it, expect } from "vitest";
import { extractCFamilyTypeAliases } from "./c-family-aliases.js";

const aliases = (src: string) => extractCFamilyTypeAliases(src.split("\n")).map((a) => `${a.name} = ${a.type}`);

describe("C and C++ type aliases", () => {
  it("reads `using` and `typedef` aliases at file and namespace scope", () => {
    expect(aliases(`#include <memory>
namespace league {
class Car;
using Ride = Car;
typedef Car Motor;
using CarPtr = std::shared_ptr<Car>;
typedef const Car* CarRef;
typedef std::map<int, Car> Garage;
using namespace std;
using league::Car;
}
`)).toEqual([
      "Ride = Car",
      "Motor = Car",
      "CarPtr = std::shared_ptr<Car>",
      "CarRef = const Car*",
      "Garage = std::map<int, Car>",
    ]);
  });

  it("reads C struct typedefs, written apart or around the struct's body", () => {
    expect(aliases(`struct car;
typedef struct car car_t;
typedef struct engine {
  int cylinders;
} engine_t;
typedef struct wheel { int size; } wheel_t;
typedef struct {
  int x;
} point_t;
typedef void (*car_cb)(car_t* c);
`)).toEqual(["car_t = car", "engine_t = engine", "wheel_t = wheel"]);
  });

  it("names a class member alias by the class's path and leaves function bodies and templates alone", () => {
    expect(aliases(`class Table {
 public:
  class Iterator;
  using Ptr = std::shared_ptr<Table>;
  void Scan() {
    using Row = Iterator;
  }
};
template <typename T>
using Box = std::vector<T>;
struct car* make_car(int seats) {
  typedef struct car vehicle;
  return 0;
}
`)).toEqual(["Table::Ptr = std::shared_ptr<Table>"]);
  });
});
