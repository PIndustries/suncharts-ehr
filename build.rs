use std::{env, fs, path::Path};

fn append(archive: &mut tar::Builder<flate2::write::GzEncoder<fs::File>>, path: &Path) {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if matches!(name, ".git" | "target" | "node_modules" | "__pycache__")
        || (name.starts_with(".env") && name != ".env.example")
        || path.extension().is_some_and(|s| {
            matches!(
                s.to_str(),
                Some(
                    "pyc"
                        | "log"
                        | "db"
                        | "sqlite"
                        | "sqlite3"
                        | "pem"
                        | "key"
                        | "p12"
                        | "pfx"
                        | "p8"
                )
            )
        })
        || path.is_symlink()
    {
        return;
    }
    if path.is_dir() {
        let mut entries = fs::read_dir(path)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        entries.sort();
        for child in entries {
            append(archive, &child);
        }
    } else {
        archive
            .append_path_with_name(path, Path::new("suncharts-ehr").join(path))
            .unwrap();
    }
}

fn main() {
    let version = fs::read_to_string("BUILD_VERSION").expect("BUILD_VERSION is required");
    let version = version.trim();
    let parts: Vec<&str> = version.split('.').collect();
    assert!(
        parts.len() == 4
            && parts[..3].iter().all(|p| p.len() == 2)
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())),
        "BUILD_VERSION must use YY.MM.DD.BUILD"
    );
    let numbers: Vec<u32> = parts
        .iter()
        .map(|p| p.parse().expect("invalid build component"))
        .collect();
    let year = 2000 + numbers[0];
    let month = numbers[1];
    let day = numbers[2];
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) => 29,
        2 => 28,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    assert!(
        day > 0 && day <= days && numbers[3] > 0,
        "BUILD_VERSION must contain a valid date and positive build number"
    );
    println!("cargo:rustc-env=SUN_CHARTS_BUILD={version}");
    // Only explicitly selected source paths enter the public source offer.
    // Never include .env, target/, .git/, credentials or patient data.
    let output = Path::new(&env::var("OUT_DIR").unwrap()).join("source.tar.gz");
    let encoder = flate2::write::GzEncoder::new(
        fs::File::create(output).unwrap(),
        flate2::Compression::default(),
    );
    let mut archive = tar::Builder::new(encoder);
    for name in [
        "src",
        "web",
        "scripts",
        "migrations",
        "tests",
        "api",
        "docs",
        ".github",
        "Cargo.toml",
        "Cargo.lock",
        "build.rs",
        "BUILD_VERSION",
        "LICENSE",
        "README.md",
        "AGENTS.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        ".env.example",
        ".gitignore",
    ] {
        println!("cargo:rerun-if-changed={name}");
        let path = Path::new(name);
        if path.exists() {
            append(&mut archive, path);
        }
    }
    archive.into_inner().unwrap().finish().unwrap();
}
