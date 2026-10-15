//! compile <out dir> <list.txt>...: serializes each list's engine to <out dir>/<list>.dat, for `Lists::new`.
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    for list in &args[1..] {
        let text = std::fs::read_to_string(list).unwrap_or_else(|e| panic!("{list}: {e}"));
        let name = Path::new(list).file_stem().unwrap();
        let out = Path::new(&args[0]).join(name).with_extension("dat");
        std::fs::write(out, filterlists::engine(&text).serialize()).unwrap();
    }
}
