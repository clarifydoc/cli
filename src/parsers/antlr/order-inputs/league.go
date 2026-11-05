package league

import (
	"fmt"
	"sort"
)

type Club struct {
	Name    string
	Players []Player
}

type Player struct {
	Name  string
	Shirt int
}

type Garage[T any] struct{ cars []T }

type Number interface{ ~int | ~float64 }

func Sum[T Number](xs []T) T {
	var total T
	for _, x := range xs {
		total += x
	}
	return total
}

func (g *Garage[T]) Add(car T) { g.cars = append(g.cars, car) }

func Map[T, U any](xs []T, f func(T) U) []U {
	out := make([]U, 0, len(xs))
	for _, x := range xs {
		out = append(out, f(x))
	}
	return out
}

// Composite literal against block, conversions against calls.
func Lineup(a, b Club, shirts []int, raw string, ch chan int) int {
	if a.Name == (Club{}).Name {
		return 0
	}
	if b == (Club{Name: "United"}) {
		return 1
	}
	for _, p := range []Player{{"Ann", 1}, {"Bob", 2}} {
		fmt.Println(p.Name)
	}
	switch x := interface{}(shirts).(type) {
	case []int:
		fmt.Println(len(x))
	}
	data := []byte(raw)
	count := int(len(data))
	label := string(rune(count))
	ptr := (*Club)(nil)
	m := (map[string]int)(nil)
	fn := (func(int) int)(nil)
	_, _, _ = ptr, m, fn
	made := make([]Player, count)
	chans := make(chan int, 4)
	table := make(map[string][]Player)
	fresh := new(Club)
	again := new(Player)
	sorted := sort.IntSlice(shirts)
	picked := Sum[int](shirts)
	mapped := Map[int, string](shirts, func(n int) string { return fmt.Sprint(n) })
	garage := &Garage[string]{}
	garage.Add(label)
	v := <-ch
	select {
	case n := <-ch:
		fmt.Println(n)
	case ch <- v:
	default:
	}
	if len(made) > 0 && v < count {
		_, _, _, _, _, _ = chans, table, fresh, again, sorted, picked
	}
	_ = mapped
	return int(float64(v) * 1.5)
}

func make2(n int) []int { return make([]int, n) }

func Run() {
	go func() { fmt.Println("kickoff") }()
	defer fmt.Println("whistle")
	Lineup(Club{}, Club{Name: "City"}, []int{1, 2, 3}, "abc", make(chan int))
}
