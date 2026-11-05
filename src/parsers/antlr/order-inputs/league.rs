//! Club and player helpers: struct literals, generics, macros, numeric literals.
use std::collections::HashMap;

pub struct Club {
    pub name: String,
    pub players: Vec<Player>,
}

#[derive(Debug, Clone)]
pub struct Player {
    pub name: String,
    pub shirt: u32,
}

pub struct Garage<T> {
    cars: Vec<T>,
}

impl<T: Clone> Garage<T> {
    pub fn new() -> Self {
        Garage { cars: Vec::new() }
    }

    pub fn add(&mut self, car: T) -> &mut Self {
        self.cars.push(car);
        self
    }
}

pub trait Scorer {
    fn score(&self, p: &Player) -> u32;
}

impl Scorer for Club {
    fn score(&self, p: &Player) -> u32 {
        p.shirt * 2
    }
}

fn pair() -> (u32, (u32, f64)) {
    (1, (2, 3.5))
}

pub fn lineup(club: &Club) -> HashMap<String, Vec<Vec<u32>>> {
    let mut table: HashMap<String, Vec<Vec<u32>>> = HashMap::new();
    let t = pair();
    let inner = t.1.0;
    let float = t.1.1 + 1.0e3 + 2.5f32 as f64 + 1.;
    let range = 0..10;
    let shifted = (1u32 << 3) >> 1;
    let raw = r#"quoted "text" here"#;
    let bytes = br"bytes";
    let ch = '\'';
    let life: &'static str = "x";
    if club.players.len() > 0 {
        let first = Player { name: String::from("Ann"), shirt: 1 };
        table.insert(first.name.clone(), vec![vec![first.shirt]]);
    }
    if let Some(p) = club.players.first() { println!("{:?}", p) }
    match club.players.len() {
        0 => {}
        n if n > 5 => println!("{}", n),
        _ => (),
    }
    let boxed: Box<dyn Fn(u32) -> u32> = Box::new(move |x| x + inner);
    let ids = club.players.iter().map(|p| p.shirt).collect::<Vec<u32>>();
    let parsed = "5".parse::<u32>().unwrap_or(0);
    let _ = (float, range, shifted, raw, bytes, ch, life, boxed, ids, parsed);
    let r#try = 1;
    assert_eq!(r#try, 1, "shirt {}", r#try);
    table
}

macro_rules! kick {
    ($($x:expr),*) => { vec![$($x),*] };
}

mod cup {
    pub fn final_round() -> Vec<u32> {
        kick![1, 2, 3]
    }
}
